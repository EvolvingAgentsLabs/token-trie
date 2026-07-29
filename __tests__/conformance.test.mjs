// The conformance table, executable.
//
// PLAN.md M1 asserted that "the opcode regex in token-trie and in skillos_robot
// is byte-identical, because they were one codebase." Two of the three shared
// regexes are. The third is not, and the divergence is load-bearing: token-trie
// accepts a bare `<|halt|>done` that skillos_robot's dispatcher rejects.
//
// These tests encode what is true, not what the README claims. If someone
// reconverges the dispatchers, the assertions here fail and get updated — which
// is the point. A table nobody can run rots the way every other doc in this
// organisation rotted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractOpcodes, compare } from './conformance/extract_opcodes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const trie = extractOpcodes(join(here, 'conformance/dispatchers/token_trie.dispatch.js'));
const robot = extractOpcodes(join(here, 'conformance/dispatchers/skillos_robot.dispatch.ts'));
const cmp = compare(trie, robot);

// The opcodes token-trie's kernel actually constrains at decode time. Everything
// else it "supports" it merely parses — the trie is built from `call` opcodes
// compiled out of each method's args_schema, plus `halt`.
const STRUCTURALLY_ENFORCED = ['call', 'halt'];

test('both dispatchers parse the same three opcodes', () => {
  assert.deepEqual(cmp.shared, ['call', 'halt', 'think']);
});

test('call and think are byte-identical across the two implementations', () => {
  assert.deepEqual(cmp.identical.sort(), ['call', 'think']);
});

test('halt has diverged — the README claim does not hold for it', () => {
  assert.deepEqual(cmp.divergent, ['halt']);
  assert.equal(trie.get('halt'), String.raw`/<\|halt\|>(?:status=)?(\w+)/`);
  assert.equal(robot.get('halt'), String.raw`/<\|halt\|>status=(\w+)/`);
});

test('the halt divergence changes what parses, not just how it reads', () => {
  const bare = '<|halt|>done';
  assert.ok(new RegExp(trie.get('halt').slice(1, -1)).test(bare));
  assert.ok(!new RegExp(robot.get('halt').slice(1, -1)).test(bare));
});

test('skillos_robot parses ten opcodes token-trie has no dispatcher for', () => {
  assert.deepEqual(cmp.onlyB, [
    'break', 'commit', 'fault', 'fork', 'loop',
    'policy', 'read', 'wait', 'write', 'yield',
  ]);
  assert.equal(cmp.onlyA.length, 0);
});

// The number M1 said to publish first. It is worse than "one of three": the one
// implementation with a structural guarantee covers 2 of the 13 opcodes the
// other one parses.
test('structural enforcement covers 2 of the 13 opcodes in the ISA', () => {
  const isa = new Set([...trie.keys(), ...robot.keys()]);
  assert.equal(isa.size, 13);
  assert.equal(STRUCTURALLY_ENFORCED.length, 2);
  for (const op of STRUCTURALLY_ENFORCED) assert.ok(isa.has(op));
});
