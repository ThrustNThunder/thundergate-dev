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
 *   2. Token Jaccard — cheap, no length filter, two tiers of partial
 *      credit (≥ 0.20 → 0.7, ≥ 0.40 → 0.85).
 *   3. Voyage `voyage-3-lite` cosine — only invoked when 1+2 < 0.85.
 *      Cosine ≥ 0.85 → 1.0, ≥ 0.70 → 0.5, else 0.0. If the API errors
 *      or no key is configured, we fall back to the tier-2 score and
 *      mark the result so doctor can see the skip.
 *
 * Per-message verdict: score ≥ 0.75 counts as a match. Daily scoring
 * (evaluator.ts) reads the raw score and weights it by response length.
 */

export interface MatchResult {
  score: number;          // 0..1 — max across the tiers we ran
  match: boolean;         // score ≥ 0.75
  tier: 1 | 2 | 3;        // tier that produced the verdict
  jaccard: number;        // raw tier-2 Jaccard, recorded for debugging
  cosine: number | null;  // tier-3 cosine if we ran it
  embedding_skipped: 'not_needed' | 'no_key' | 'error' | 'used';
}

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

const MATCH_THRESHOLD = 0.75;

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
        jaccard: jaccardOf(na, nb),
        cosine: null,
        embedding_skipped: 'not_needed'
      };
    }
  }

  // Tier 2 — token Jaccard with no length filter.
  const jac = jaccardOf(na, nb);
  let tier2: number;
  if (jac >= 0.4) tier2 = 0.85;
  else if (jac >= 0.2) tier2 = 0.7;
  else tier2 = 0;

  // Short-circuit: tier 2 alone clears the match bar — no embedding needed.
  if (tier2 >= 0.85) {
    return {
      score: tier2,
      match: tier2 >= MATCH_THRESHOLD,
      tier: 2,
      jaccard: jac,
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
      jaccard: jac,
      cosine: null,
      embedding_skipped: 'no_key'
    };
  }

  let cosine: number | null = null;
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
    }
  } catch {
    cosine = null;
  }

  if (cosine === null) {
    return {
      score: tier2,
      match: tier2 >= MATCH_THRESHOLD,
      tier: 2,
      jaccard: jac,
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
    jaccard: jac,
    cosine,
    embedding_skipped: 'used'
  };
}

// ── String helpers ─────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const tok of normalized.split(' ')) {
    if (tok) out.add(tok);
  }
  return out;
}

function jaccardOf(na: string, nb: string): number {
  const sa = tokenize(na);
  const sb = tokenize(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let overlap = 0;
  for (const tok of sa) if (sb.has(tok)) overlap++;
  const union = sa.size + sb.size - overlap;
  return union > 0 ? overlap / union : 0;
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ input: texts, model }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        throw new Error(`voyage HTTP ${res.status}`);
      }
      const data: any = await res.json();
      if (!Array.isArray(data?.data)) throw new Error('voyage: malformed response');
      return data.data
        .map((row: any) => (Array.isArray(row?.embedding) ? row.embedding : null))
        .filter((v: number[] | null): v is number[] => v !== null);
    } finally {
      clearTimeout(timer);
    }
  };
}
