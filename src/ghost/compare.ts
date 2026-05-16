/**
 * Ghost Jon — tiered match comparator
 *
 * Replaces the old single-Jaccard heuristic with a layered scorer.
 * Different models (Sonnet vs Haiku) phrase the same answer in very
 * different words, so token overlap alone underreports agreement; at
 * the same time a $0.02/1M-token embedding call on every shadow pair
 * would be silly when most pairs are short acks. Three tiers, cheapest
 * first, take the max:
 *
 *   1. Exact / near-exact (normalized equality or Levenshtein ≤ 0.15)
 *      — catches HEARTBEAT_OK, "ok", identical strings.
 *   2. Token Jaccard composite — max of:
 *        - stopword-stripped unigram Jaccard
 *        - bigram Jaccard (phrase-level)
 *        - longest-common-substring ratio over the shorter response
 *      With model-style fingerprints (markdown, code fences) stripped
 *      before tokenization. Two tiers of partial credit
 *      (≥ 0.20 → 0.7, ≥ 0.40 → 0.85).
 *   3. Voyage `voyage-3-lite` cosine — only invoked when 1+2 < 0.85.
 *      Cosine ≥ 0.85 → 1.0, ≥ 0.70 → 0.5, else 0.0. Results are LRU-cached
 *      by normalized-pair so a flapping watcher doesn't burn the API
 *      budget. If the API errors or no key is configured, we fall back
 *      to the tier-2 score and mark the result so doctor can see the skip.
 *
 * Per-message verdict: score ≥ 0.75 counts as a match. Daily scoring
 * (evaluator.ts) reads the raw score and weights it by response length.
 */

export interface MatchResult {
  score: number;          // 0..1 — max across the tiers we ran
  match: boolean;         // score ≥ 0.75
  tier: 1 | 2 | 3;        // tier that produced the verdict
  jaccard: number;        // raw tier-2 best signal, recorded for debugging
  cosine: number | null;  // tier-3 cosine if we ran it
  embedding_skipped: 'not_needed' | 'no_key' | 'error' | 'used' | 'cached';
}

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

const MATCH_THRESHOLD = 0.75;
// Tier-2 partial-credit bands; tuned so a single strong signal across
// unigram/bigram/substring is enough to skip the embedding call.
const TIER2_STRONG = 0.4;
const TIER2_WEAK = 0.2;

// Stopwords stripped from unigram Jaccard. These are the words that
// every English response shares and that dominated the old denominator —
// removing them lifts true semantic overlap out of tier-2 limbo.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'so', 'the', 'this', 'that', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'their', 'his', 'her', 'its',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'into', 'about', 'over', 'under', 'up', 'down', 'out', 'off',
  'do', 'does', 'did', 'doing', 'done', 'have', 'has', 'had', 'will',
  'would', 'could', 'should', 'can', 'may', 'might', 'must',
  'not', 'no', 'yes', 'if', 'then', 'than', 'because', 'just', 'only',
  'also', 'too', 'very', 'really', 'still', 'now', 'when', 'where',
  'what', 'who', 'why', 'how', 'all', 'any', 'some', 'each', 'every',
  'more', 'most', 'less', 'few', 'many', 'much', 'such',
  'one', 'two', 'three', 'first', 'second', 'next', 'last',
  'ok', 'okay', 'yeah', 'yes', 'sure', 'right', 'well', 'oh', 'hey'
]);

/**
 * Run the tiered comparison. `embed`, when provided, is called with the
 * pair of normalized strings; we expect two equal-length vectors back.
 * The caller decides whether to wire it to Voyage, mock it, or leave it
 * undefined (tier 3 is then skipped cleanly).
 */
export async function compareResponses(
  a: string,
  b: string,
  embed?: EmbeddingFn
): Promise<MatchResult> {
  if (!a || !b) {
    return {
      score: 0,
      match: false,
      tier: 1,
      jaccard: 0,
      cosine: null,
      embedding_skipped: 'not_needed'
    };
  }

  const na = normalize(a);
  const nb = normalize(b);

  // Tier 1 — exact / near-exact.
  if (na === nb) {
    return {
      score: 1,
      match: true,
      tier: 1,
      jaccard: 1,
      cosine: null,
      embedding_skipped: 'not_needed'
    };
  }
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen > 0) {
    const dist = levenshtein(na, nb);
    if (dist / maxLen <= 0.15) {
      return {
        score: 1,
        match: true,
        tier: 1,
        jaccard: bestTier2Signal(na, nb).signal,
        cosine: null,
        embedding_skipped: 'not_needed'
      };
    }
  }

  // Tier 2 — composite of stopword-stripped unigram Jaccard, bigram
  // Jaccard, and longest-common-substring ratio. We take the max so
  // *any* of the three lifting a pair into tier-2-strong is enough.
  const { signal: bestSignal } = bestTier2Signal(na, nb);
  let tier2: number;
  if (bestSignal >= TIER2_STRONG) tier2 = 0.85;
  else if (bestSignal >= TIER2_WEAK) tier2 = 0.7;
  else tier2 = 0;

  // Short-circuit: tier 2 alone clears the match bar — no embedding needed.
  if (tier2 >= 0.85) {
    return {
      score: tier2,
      match: tier2 >= MATCH_THRESHOLD,
      tier: 2,
      jaccard: bestSignal,
      cosine: null,
      embedding_skipped: 'not_needed'
    };
  }

  // Tier 3 — embedding cosine, if available.
  if (!embed) {
    return {
      score: tier2,
      match: tier2 >= MATCH_THRESHOLD,
      tier: 2,
      jaccard: bestSignal,
      cosine: null,
      embedding_skipped: 'no_key'
    };
  }

  // LRU pair cache: identical normalized pairs are extremely common in
  // shadow traffic (Jon repeats himself; Haiku does too). Cache hits are
  // free; misses go to Voyage.
  let cosine: number | null = null;
  let fromCache = false;
  const cacheKey = pairCacheKey(na, nb);
  const cached = embeddingPairCache.get(cacheKey);
  if (cached !== undefined) {
    cosine = cached;
    fromCache = true;
  } else {
    try {
      const vecs = await embed([a, b]);
      if (
        Array.isArray(vecs) &&
        vecs.length === 2 &&
        Array.isArray(vecs[0]) &&
        Array.isArray(vecs[1]) &&
        vecs[0].length === vecs[1].length &&
        vecs[0].length > 0
      ) {
        cosine = cosineSimilarity(vecs[0], vecs[1]);
        embeddingPairCache.set(cacheKey, cosine);
      }
    } catch (err) {
      cosine = null;
      const now = Date.now();
      if (now - lastWarnedAt >= 60_000) {
        lastWarnedAt = now;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ghost/compare] voyage embed failed: ${msg}`);
      }
    }
  }

  if (cosine === null) {
    return {
      score: tier2,
      match: tier2 >= MATCH_THRESHOLD,
      tier: 2,
      jaccard: bestSignal,
      cosine: null,
      embedding_skipped: 'error'
    };
  }

  let tier3: number;
  if (cosine >= 0.85) tier3 = 1;
  else if (cosine >= 0.7) tier3 = 0.5;
  else tier3 = 0;

  const score = Math.max(tier2, tier3);
  const tier = tier3 >= tier2 ? 3 : 2;
  return {
    score,
    match: score >= MATCH_THRESHOLD,
    tier,
    jaccard: bestSignal,
    cosine,
    embedding_skipped: fromCache ? 'cached' : 'used'
  };
}

// ── Tier-2 composite signals ───────────────────────────────────────────────

/**
 * Returns the best tier-2 signal across three sub-metrics:
 *   1. Stopword-stripped unigram Jaccard — semantic-content overlap.
 *   2. Bigram Jaccard — phrase-level overlap ("relay is down" vs "relay went down").
 *   3. Longest-common-substring ratio — anchored verbatim overlap.
 *
 * Returning the max means any one strong signal alone is enough to
 * tier-2-clear; we don't average because averaging penalizes a pair
 * that's identical phrase-by-phrase but uses different stopwords.
 *
 * `which` is exported for callers/tests that want to know which sub-metric
 * fired — not currently logged in entries because the harness keeps the
 * log schema stable, but useful from a debugger.
 */
export function bestTier2Signal(
  na: string,
  nb: string
): { signal: number; which: 'unigram' | 'bigram' | 'substring' } {
  const uni = jaccardOfStopworded(na, nb);
  const bi = bigramJaccard(na, nb);
  const sub = substringRatio(na, nb);

  let best = uni;
  let which: 'unigram' | 'bigram' | 'substring' = 'unigram';
  if (bi > best) {
    best = bi;
    which = 'bigram';
  }
  if (sub > best) {
    best = sub;
    which = 'substring';
  }
  return { signal: best, which };
}

// ── String helpers ─────────────────────────────────────────────────────────

/**
 * Normalize for comparison: strip markdown emphasis/headers/code fences
 * before tokenizing so Sonnet's `**bold**` and Haiku's bare text don't
 * count as different content. The stripping is conservative — we keep
 * the literal text inside fences/emphasis, just lose the markers.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    // Strip code fences but keep contents.
    .replace(/```[a-z0-9]*\n?/g, ' ')
    .replace(/```/g, ' ')
    // Strip inline code backticks.
    .replace(/`+/g, ' ')
    // Strip markdown headers (#, ##, ...).
    .replace(/^#{1,6}\s+/gm, '')
    // Strip emphasis markers but preserve their contents.
    .replace(/\*+/g, ' ')
    .replace(/_+/g, ' ')
    // Strip bullet/list markers at line starts.
    .replace(/^\s*[-•]\s+/gm, '')
    // Strip remaining punctuation.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(normalized: string): string[] {
  const out: string[] = [];
  for (const tok of normalized.split(' ')) {
    if (tok) out.push(tok);
  }
  return out;
}

function contentTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const tok of tokensOf(normalized)) {
    if (STOPWORDS.has(tok)) continue;
    if (tok.length <= 1) continue;
    out.add(tok);
  }
  return out;
}

function jaccardOfStopworded(na: string, nb: string): number {
  const sa = contentTokens(na);
  const sb = contentTokens(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let overlap = 0;
  for (const tok of sa) if (sb.has(tok)) overlap++;
  const union = sa.size + sb.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function bigramSet(normalized: string): Set<string> {
  const toks = tokensOf(normalized);
  const out = new Set<string>();
  for (let i = 0; i < toks.length - 1; i++) {
    out.add(`${toks[i]} ${toks[i + 1]}`);
  }
  return out;
}

function bigramJaccard(na: string, nb: string): number {
  const sa = bigramSet(na);
  const sb = bigramSet(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let overlap = 0;
  for (const g of sa) if (sb.has(g)) overlap++;
  const union = sa.size + sb.size - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Longest-common-substring ratio (over the shorter string). Captures
 * the case where one response is a near-verbatim quote of the other but
 * surrounded by different wrappers — Jon's "the answer is X" inside
 * Haiku's longer "ok so basically the answer is X and also Y". Jaccard
 * underrates this; substring overlap catches it.
 *
 * O(n*m) time / O(m) space rolling-row table. Strings here are post-
 * normalization (typically a few hundred chars), so this is cheap.
 */
function substringRatio(na: string, nb: string): number {
  if (!na || !nb) return 0;
  // Cap to keep this O(n*m) bound predictable on the rare giant pair.
  const A = na.length > 2000 ? na.slice(0, 2000) : na;
  const B = nb.length > 2000 ? nb.slice(0, 2000) : nb;
  const m = A.length;
  const n = B.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  let lcs = 0;
  for (let i = 1; i <= m; i++) {
    const ca = A.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      curr[j] = ca === B.charCodeAt(j - 1) ? prev[j - 1] + 1 : 0;
      if (curr[j] > lcs) lcs = curr[j];
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return lcs / Math.min(m, n);
}

/**
 * Iterative Levenshtein with two rolling rows. O(n*m) time, O(min) space.
 * We only call it after the Tier-1 equality check, so it stays cheap for
 * the cases it actually fires on (similar-length, mostly-equal strings).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter one so the rolling row is small.
  if (a.length < b.length) [a, b] = [b, a];

  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost  // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Embedding pair cache ───────────────────────────────────────────────────

/**
 * Bounded Map-as-LRU. JS Maps preserve insertion order; we delete-and-
 * reinsert on hit to move to the tail, then evict head on overflow.
 * Cap is 2048 pairs — at 2 vectors per call, ~64 KB JS overhead with
 * negligible memory cost and a useful hit-rate on tight conversation
 * loops where the same back-and-forth recurs.
 */
const PAIR_CACHE_LIMIT = 2048;
const embeddingPairCache = new Map<string, number>();

function pairCacheKey(na: string, nb: string): string {
  // Order-insensitive: cosine(a,b) === cosine(b,a). Always alphabetize
  // so the cache hits regardless of which response arrived first.
  return na < nb ? `${na} ${nb}` : `${nb} ${na}`;
}

// Override Map.get to be LRU-aware without touching the call sites.
const origGet = embeddingPairCache.get.bind(embeddingPairCache);
const origSet = embeddingPairCache.set.bind(embeddingPairCache);
embeddingPairCache.get = (k: string) => {
  if (!embeddingPairCache.has(k)) return undefined;
  const v = origGet(k);
  // Move to tail.
  embeddingPairCache.delete(k);
  origSet(k, v as number);
  return v;
};
embeddingPairCache.set = (k: string, v: number) => {
  if (embeddingPairCache.has(k)) embeddingPairCache.delete(k);
  origSet(k, v);
  while (embeddingPairCache.size > PAIR_CACHE_LIMIT) {
    const firstKey = embeddingPairCache.keys().next().value as string | undefined;
    if (firstKey === undefined) break;
    embeddingPairCache.delete(firstKey);
  }
  return embeddingPairCache;
};

// Rate-limit for surfacing embed errors — once per minute is enough to
// distinguish 429 from a key/network problem without flooding the log.
let lastWarnedAt = 0;

// ── Voyage embedding adapter ───────────────────────────────────────────────

/**
 * Returns a callable that hits Voyage's `voyage-3-lite` endpoint with a
 * short timeout. Errors return null vectors so the comparator can fall
 * back to its tier-2 verdict.
 *
 * Voyage was acquired by Anthropic — the API is still hosted at
 * api.voyageai.com and uses a separate VOYAGE_API_KEY. Keeping the key
 * distinct from the Anthropic message-API key matches today's billing
 * boundary; if Anthropic later folds embeddings into their main API we
 * swap the URL/header and leave the rest of the comparator unchanged.
 */
export function voyageEmbedder(
  apiKey: string,
  opts: { model?: string; timeoutMs?: number } = {}
): EmbeddingFn {
  const model = opts.model ?? 'voyage-3-lite';
  const timeoutMs = opts.timeoutMs ?? 5000;
  return async (texts: string[]): Promise<number[][]> => {
    const callOnce = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({ input: texts, model }),
          signal: ctrl.signal
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await callOnce();
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 500));
      res = await callOnce();
      if (res.status === 429) {
        throw new Error('Voyage rate limited after retry');
      }
    }
    if (!res.ok) {
      throw new Error(`voyage HTTP ${res.status}`);
    }
    const data: any = await res.json();
    if (!Array.isArray(data?.data)) throw new Error('voyage: malformed response');
    return data.data
      .map((row: any) => (Array.isArray(row?.embedding) ? row.embedding : null))
      .filter((v: number[] | null): v is number[] => v !== null);
  };
}
