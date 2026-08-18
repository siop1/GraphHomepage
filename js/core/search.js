/**
 * search.js — lightweight client-side search over the currently loaded
 * node set (favorites tree or full bookmarks tree). No indexing library;
 * for the scale of a bookmarks/favorites tree (hundreds to low thousands
 * of items) a simple scored substring/subsequence match is plenty fast
 * and avoids pulling in a dependency.
 */

/**
 * Scores how well `query` matches `text`. Higher is better; 0 means no match.
 * - exact substring match scores highest, boosted if it's a prefix
 * - otherwise falls back to in-order subsequence matching (fuzzy)
 */
function score(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  if (!t) return 0;

  const idx = t.indexOf(q);
  if (idx !== -1) {
    let s = 100 - idx; // earlier match = better
    if (idx === 0) s += 50;
    if (t.length === q.length) s += 30;
    return s;
  }

  // fuzzy subsequence fallback
  let ti = 0, matched = 0, first = -1, last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0; // not even a subsequence — no match
    if (first === -1) first = found;
    last = found;
    ti = found + 1;
    matched++;
  }
  const span = last - first + 1;
  const density = matched / span;
  return Math.max(1, Math.round(density * 40));
}

/**
 * Searches a flat array of {id, label, url, type, ...} items.
 * Returns matches sorted best-first: [{ item, score }]
 */
export function searchNodes(items, query, { limit = 50 } = {}) {
  const q = query.trim();
  if (!q) return [];
  const results = [];
  for (const item of items) {
    const labelScore = score(q, item.label);
    const urlScore = item.url ? score(q, item.url) * 0.6 : 0;
    const best = Math.max(labelScore, urlScore);
    if (best > 0) results.push({ item, score: best });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
