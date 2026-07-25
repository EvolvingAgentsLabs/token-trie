// Acceptance test for PLAN.md phase 1.
//
// The whole claim of phase 1 is that compiling opcodes from each method's
// args_schema produces exactly what was previously written out by hand. So the
// test compares against the hand-written lists, captured here verbatim from the
// manifests as they stood before the change (commit preceding this one). If the
// compiler ever drifts, this fails loudly rather than silently changing what
// the model is allowed to emit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileOpcodes, resolveOpcodes, UnsupportedSchemaError }
  from '../mobile/public/demos/_kernel/compile_opcodes.js';
import { Cartridge } from '../mobile/public/demos/_kernel/cartridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CART = path.join(HERE, '..', 'mobile', 'public', 'demos', '_cart', 'game');

// ── The hand-written opcode lists, exactly as they were ────────────────────

const HAND_WRITTEN = {
  tetris: {
    move: [
      '<|call|>tetris.move {"action":"left"}<|/call|>\n',
      '<|call|>tetris.move {"action":"right"}<|/call|>\n',
      '<|call|>tetris.move {"action":"down"}<|/call|>\n',
      '<|call|>tetris.move {"action":"rotate"}<|/call|>\n',
      '<|call|>tetris.move {"action":"drop"}<|/call|>\n',
    ],
    observe: ['<|call|>tetris.observe {}<|/call|>\n'],
    reset: ['<|call|>tetris.reset {}<|/call|>\n'],
  },
  scavenger: {
    move: [
      '<|call|>scavenger.move {"dir":"north"}<|/call|>\n',
      '<|call|>scavenger.move {"dir":"south"}<|/call|>\n',
      '<|call|>scavenger.move {"dir":"east"}<|/call|>\n',
      '<|call|>scavenger.move {"dir":"west"}<|/call|>\n',
    ],
    pickup: ['<|call|>scavenger.pickup {}<|/call|>\n'],
    drop: ['<|call|>scavenger.drop {}<|/call|>\n'],
    look: ['<|call|>scavenger.look {}<|/call|>\n'],
  },
};

const loaderFor = (game) => async (schemaPath) =>
  JSON.parse(await readFile(path.join(CART, game, schemaPath), 'utf8'));

const manifestFor = async (game) =>
  JSON.parse(await readFile(path.join(CART, game, 'manifest.json'), 'utf8'));

// ── Byte-identical output, per method ──────────────────────────────────────

for (const [game, methods] of Object.entries(HAND_WRITTEN)) {
  test(`${game}: compiled opcodes match the hand-written list`, async () => {
    const manifest = await manifestFor(game);
    const load = loaderFor(game);

    assert.deepEqual(
      Object.keys(manifest.methods).sort(),
      Object.keys(methods).sort(),
      'manifest declares a different set of methods than this test knows about',
    );

    for (const [method, expected] of Object.entries(methods)) {
      const actual = await resolveOpcodes(game, method, manifest.methods[method], load);
      assert.deepEqual(actual, expected, `${game}.${method}`);
    }
  });
}

// ── The trie built from the manifest matches one built from the old lists ──

for (const game of Object.keys(HAND_WRITTEN)) {
  test(`${game}: trie built from schema equals trie built from hand-written opcodes`, async () => {
    // A tokenizer standing in for the model's: deterministic, and it splits on
    // characters so any difference in the opcode strings shows up as a
    // difference in the trie.
    const tokenize = async (s) => [...s].map(c => c.codePointAt(0));

    const fromSchema = new Cartridge(await manifestFor(game), { loadSchema: loaderFor(game) });
    await fromSchema.build(tokenize);

    const handManifest = await manifestFor(game);
    for (const [method, opcodes] of Object.entries(HAND_WRITTEN[game])) {
      handManifest.methods[method] = { ...handManifest.methods[method], opcodes };
    }
    const fromHand = new Cartridge(handManifest);
    await fromHand.build(tokenize);

    assert.deepEqual(
      fromSchema.trie.opcodes.map(o => o.string),
      fromHand.trie.opcodes.map(o => o.string),
      'trie opcode text differs',
    );
    assert.deepEqual(
      [...fromSchema.allMethodIndices()].sort(),
      [...fromHand.allMethodIndices()].sort(),
      'method opcode indices differ',
    );
    assert.deepEqual(
      [...fromSchema.haltIndices()].sort(),
      [...fromHand.haltIndices()].sort(),
      'halt opcode indices differ',
    );
  });
}

// ── The compiler's boundaries ──────────────────────────────────────────────

test('an empty schema compiles to a single no-args opcode', () => {
  assert.deepEqual(
    compileOpcodes('c', 'm', { type: 'object' }),
    ['<|call|>c.m {}<|/call|>\n'],
  );
});

test('multiple enum properties produce the cartesian product in declaration order', () => {
  const schema = {
    type: 'object',
    properties: { a: { enum: ['x', 'y'] }, b: { enum: [1, 2] } },
  };
  assert.deepEqual(compileOpcodes('c', 'm', schema), [
    '<|call|>c.m {"a":"x","b":1}<|/call|>\n',
    '<|call|>c.m {"a":"x","b":2}<|/call|>\n',
    '<|call|>c.m {"a":"y","b":1}<|/call|>\n',
    '<|call|>c.m {"a":"y","b":2}<|/call|>\n',
  ]);
});

test('a non-enum property is refused, and says which phase covers it', () => {
  const schema = { type: 'object', properties: { x: { type: 'integer' } } };
  assert.throws(
    () => compileOpcodes('c', 'm', schema),
    (err) => err instanceof UnsupportedSchemaError && /phase 2/.test(err.message),
  );
});

test('an explicit opcodes array still wins over the schema', async () => {
  const explicit = ['<|call|>c.m {"anything":"goes"}<|/call|>\n'];
  const out = await resolveOpcodes('c', 'm', { opcodes: explicit, args_schema: 'x.json' }, null);
  assert.deepEqual(out, explicit);
});
