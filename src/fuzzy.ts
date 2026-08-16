// Frozen fuzzy collision check (SPEC §2, rev 3). Two signals: Levenshtein on
// the normalized ids, and a prefix-aware Jaccard of the token sets. Either one
// firing is a collision.

const PREFIX_MIN = 4;
const JACCARD_MIN = 0.5;
const LEV_MAX = 2;

/** Normalized form for Levenshtein: lowercase, strip `-` and `_`. */
export function normalizeId(id: string): string {
  return id.toLowerCase().replace(/[-_]/g, "");
}

/** Token set: lowercase, split on `-`/`_`, non-empty, de-duplicated. */
export function tokenize(id: string): string[] {
  const seen = new Set<string>();
  for (const token of id.toLowerCase().split(/[-_]/)) {
    if (token.length > 0) seen.add(token);
  }
  return [...seen];
}

/** Two tokens are equal if identical, or one is a prefix of the other with min length ≥ 4. */
export function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < PREFIX_MIN) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Standard Levenshtein edit distance (two-row DP; Int32Array dodges strict index-undefined). */
export function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m]!;
}

/** Maximum one-to-one matching between two token arrays under `tokensEqual` (Kuhn's algorithm). */
function maxTokenMatching(a: string[], b: string[]): number {
  const matchOfB = new Int32Array(b.length).fill(-1);

  const augment = (ai: number, used: Uint8Array): boolean => {
    for (let j = 0; j < b.length; j++) {
      if (used[j] === 0 && tokensEqual(a[ai]!, b[j]!)) {
        used[j] = 1;
        const owner = matchOfB[j]!;
        if (owner === -1 || augment(owner, used)) {
          matchOfB[j] = ai;
          return true;
        }
      }
    }
    return false;
  };

  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (augment(i, new Uint8Array(b.length))) count++;
  }
  return count;
}

/** Prefix-aware Jaccard: |∩| / (|A| + |B| − |∩|), |∩| = max token matching. */
export function prefixAwareJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const intersection = maxTokenMatching(a, b);
  return intersection / (a.length + b.length - intersection);
}

/** Do two ids collide under the frozen rev-3 rule? */
export function idsCollide(a: string, b: string): boolean {
  if (levenshtein(normalizeId(a), normalizeId(b)) <= LEV_MAX) return true;
  if (prefixAwareJaccard(tokenize(a), tokenize(b)) >= JACCARD_MIN) return true;
  return false;
}

/** Up to `limit` existing ids closest to `target` (by normalized Levenshtein), for "did you mean" hints. */
export function nearMatches(
  target: string,
  existingIds: string[],
  limit = 3,
): string[] {
  const norm = normalizeId(target);
  return existingIds
    .map((id) => ({ id, distance: levenshtein(norm, normalizeId(id)) }))
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.id);
}

export interface ExistingTopic {
  id: string;
  aliases: string[];
}

/**
 * All existing ids/aliases that collide with `newId` (SPEC §2: check against
 * every existing id and alias). One match reported per topic.
 */
export function findCollisions(
  newId: string,
  existing: ExistingTopic[],
): string[] {
  const matches: string[] = [];
  for (const topic of existing) {
    if (idsCollide(newId, topic.id)) {
      matches.push(topic.id);
      continue;
    }
    for (const alias of topic.aliases) {
      if (idsCollide(newId, alias)) {
        matches.push(alias);
        break;
      }
    }
  }
  return matches;
}
