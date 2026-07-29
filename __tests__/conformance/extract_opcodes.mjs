// Read the opcode regexes straight out of each dispatcher's source.
//
// Deliberately textual. The point of this suite is to compare what the two
// implementations *say*, byte for byte, so anything that normalises or
// re-compiles the pattern would destroy the evidence. A regex that differs by
// one optional group is a conformance failure, and it has to survive the trip.

import { readFileSync } from 'node:fs';

const DECL = /const\s+([A-Z]+)_RE\s*=\s*(\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/])+\/[gimsuy]*)\s*;/g;

/**
 * @param {string} path source file of a dispatcher
 * @returns {Map<string, string>} opcode name (lowercase) -> regex source, verbatim
 */
export function extractOpcodes(path) {
  const src = readFileSync(path, 'utf8');
  const out = new Map();
  for (const m of src.matchAll(DECL)) {
    out.set(m[1].toLowerCase(), m[2]);
  }
  return out;
}

/**
 * Compare two dispatchers.
 *
 * @returns {{shared: string[], identical: string[], divergent: string[],
 *            onlyA: string[], onlyB: string[]}}
 */
export function compare(a, b) {
  const shared = [...a.keys()].filter((k) => b.has(k)).sort();
  return {
    shared,
    identical: shared.filter((k) => a.get(k) === b.get(k)),
    divergent: shared.filter((k) => a.get(k) !== b.get(k)),
    onlyA: [...a.keys()].filter((k) => !b.has(k)).sort(),
    onlyB: [...b.keys()].filter((k) => !a.has(k)).sort(),
  };
}
