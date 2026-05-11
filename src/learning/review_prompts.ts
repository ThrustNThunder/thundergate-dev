/**
 * Learning-loop review prompts.
 *
 * Adapted from the Hermes background-review fork model — Hermes spawns a
 * separate AIAgent with these prompts plus the conversation snapshot, and
 * decides whether to save memories or update skills.
 *
 * ThunderGate does not (yet) spawn a separate review fork — the trigger
 * engine uses these prompts as the *contract* for what its extractors
 * should be detecting. When a real LLM-backed review fork lands, this
 * is the prompt it will use; until then, the engine's regex/heuristic
 * paths in `triggers.ts` aim at the same signal.
 *
 * Tone notes specific to ThunderAI vs. generic Hermes:
 *   - The user is Michael — direct, no fluff, pushes back when right.
 *   - Captured rules should land Michael's reasoning ("why") not just
 *     the directive, so future Jon can judge edge cases.
 *   - Skill creation is a *last resort*. We have a small library; we
 *     want it to deepen, not balloon.
 */

export const MEMORY_REVIEW_PROMPT = `
You are reviewing a recent slice of the Jon ↔ Michael conversation to decide
what (if anything) belongs in long-term memory.

Save sparingly. Save when:
  1. Michael revealed something about himself — preferences, work style,
     personal facts, family, gear, business context.
  2. Michael expressed an expectation about how Jon should behave —
     a rule, a "don't do X", a "from now on Y".
  3. A correction landed — Michael said Jon was wrong about something,
     and the corrected fact is one Jon will need again.
  4. A fact about the team, business, or ThunderAI infrastructure that
     is non-obvious and not derivable from the code or the docs.

Skip when:
  - The information is ephemeral (this turn's task, current PR state).
  - It's already documented in WHO_YOU_ARE.md / ARCHITECTURE.md / REPOS.md.
  - It's a code pattern derivable by reading the repo.

For each memory worth saving, format as:
  category: corrections | preferences | facts | feedback
  importance: critical | high | normal
  value: the rule/fact, then on a new line:
    Why: <Michael's stated or implied reason>
    How to apply: <when this kicks in>

If nothing stands out, return the single line: "Nothing to save."
`.trim();

export const SKILL_REVIEW_PROMPT = `
You are reviewing the skill library against the most recent task.

BIAS HARD TOWARD UPDATING, NOT CREATING. The library is small and
deepening existing skills is more valuable than fragmenting into
near-duplicates. Preference order:

  1. UPDATE A CURRENTLY-LOADED SKILL — extend it with the new pattern,
     gotcha, or workaround surfaced this turn. This is the default.
  2. UPDATE AN EXISTING SKILL of similar category — same as (1) but
     reaching for a relevant skill that wasn't loaded.
  3. ADD a focused note as a section in an existing skill rather than
     splitting it out.
  4. CREATE A NEW SKILL — only when nothing existing fits and the
     pattern is broadly reusable (not a one-off).

What makes a good skill capture:
  - A technical procedure that worked end-to-end (not a single step).
  - A debugging path that resolved a recurring class of issue.
  - A workflow that saved meaningful time and will recur.

What does NOT belong:
  - Trivia ("ran 'npm install' to install dependencies").
  - Patterns the code already documents.
  - One-off fixes specific to a single bug instance.

If nothing rises to the bar, return the single line: "Nothing to save."
`.trim();

/**
 * Surface-level keyword extraction — used by `triggers.ts` until the
 * background review fork is implemented. Pulls out lowercase tokens of
 * length ≥ 5 that aren't English stopwords, suitable for similar-skill
 * lookup via `SessionDB.findSimilarSkills`.
 */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'before', 'being',
  'below', 'between', 'could', 'doing', 'during', 'each', 'further',
  'having', 'here', 'into', 'itself', 'more', 'most', 'other', 'over',
  'should', 'some', 'such', 'than', 'that', 'their', 'them', 'these',
  'they', 'this', 'those', 'through', 'under', 'until', 'were', 'what',
  'when', 'where', 'which', 'while', 'will', 'would', 'your', 'yours',
  'with', 'from', 'just', 'only', 'very', 'have', 'been', 'does', 'doesn',
  'didn', 'wasn', 'weren', 'hasn', 'haven', 'isn', 'shouldn', 'wouldn'
]);

export function extractKeywords(text: string, limit: number = 8): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 5 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}
