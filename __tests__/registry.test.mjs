// PLAN.md phase 4 — several cartridges in one trie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartridgeRegistry } from '../mobile/public/demos/_kernel/registry.js';
import { Cartridge } from '../mobile/public/demos/_kernel/cartridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CART = path.join(HERE, '..', 'mobile', 'public', 'demos', '_cart', 'game');

const tokenize = async (s) => [...s].map(c => c.codePointAt(0));
const loaderFor = (game) => async (p) => JSON.parse(await readFile(path.join(CART, game, p), 'utf8'));
const manifestFor = async (game) => JSON.parse(await readFile(path.join(CART, game, 'manifest.json'), 'utf8'));

async function bothGames() {
  const reg = new CartridgeRegistry();
  reg.add(new Cartridge(await manifestFor('tetris'), { loadSchema: loaderFor('tetris') }));
  reg.add(new Cartridge(await manifestFor('scavenger'), { loadSchema: loaderFor('scavenger') }));
  await reg.build(tokenize);
  return reg;
}

test('two cartridges share one trie and keep their own opcodes', async () => {
  const reg = await bothGames();

  assert.deepEqual(reg.names(), ['tetris', 'scavenger']);
  // tetris: move(5) + observe(1) + reset(1) = 7
  // scavenger: move(4) + pickup(1) + drop(1) + look(1) = 7
  assert.equal(reg.cartridgeIndices('tetris').size, 7);
  assert.equal(reg.cartridgeIndices('scavenger').size, 7);
  assert.equal(reg.allMethodIndices().size, 14);
  // ...plus three halt opcodes, shared rather than duplicated.
  assert.equal(reg.haltIndices().size, 3);
  assert.equal(reg.size(), 17);

  const strings = reg.trie.opcodes.map(o => o.string);
  assert.ok(strings.some(s => s.includes('tetris.move')));
  assert.ok(strings.some(s => s.includes('scavenger.move')));
});

test('halt opcodes are inserted once, and every cartridge points at the same ones', async () => {
  const reg = await bothGames();
  const halts = reg.trie.opcodes.filter(o => o.label === '__halt__');
  assert.equal(halts.length, 3, 'three halt opcodes, not six');

  const tetris = reg.get('tetris').haltIndices();
  const scavenger = reg.get('scavenger').haltIndices();
  assert.deepEqual([...tetris].sort(), [...scavenger].sort(),
    'both cartridges should reference the same halt indices');
});

test('same-named methods in different cartridges stay distinct', async () => {
  const reg = await bothGames();
  const tetrisMove = reg.methodIndices('tetris.move');
  const scavMove = reg.methodIndices('scavenger.move');

  assert.equal(tetrisMove.size, 5);
  assert.equal(scavMove.size, 4);
  for (const idx of tetrisMove) {
    assert.ok(!scavMove.has(idx), 'the two move methods must not share opcode indices');
  }
});

test('restricting to one cartridge excludes the other at the trie level', async () => {
  const reg = await bothGames();
  const onlyTetris = reg.cartridgeIndices('tetris');

  // From the root, the only legal continuations lead to tetris opcodes.
  const valid = reg.trie.getValidNextTokens([], onlyTetris);
  assert.ok(valid.size > 0);

  // Walking a scavenger-only prefix under that restriction dead-ends.
  const scavPrefix = [...'<|call|>scavenger.'].map(c => c.codePointAt(0));
  const dead = reg.trie.getValidNextTokens(scavPrefix, onlyTetris);
  assert.equal(dead.size, 0, 'scavenger should be unreachable when restricted to tetris');
});

test('an unqualified method name is refused', async () => {
  const reg = await bothGames();
  assert.throws(() => reg.methodIndices('move'), /qualified as "cartridge\.method"/);
});

test('unknown cartridges and methods are named in the error', async () => {
  const reg = await bothGames();
  assert.throws(() => reg.cartridgeIndices('pong'), /no cartridge named "pong"/);
  assert.throws(() => reg.methodIndices('tetris.fly'), /has no method "fly"/);
  assert.throws(() => reg.methodIndices('pong.move'), /no cartridge named "pong"/);
});

test('duplicate cartridge names are refused', async () => {
  const reg = new CartridgeRegistry();
  reg.add(new Cartridge(await manifestFor('tetris'), { loadSchema: loaderFor('tetris') }));
  await assert.rejects(async () => {
    reg.add(new Cartridge(await manifestFor('tetris'), { loadSchema: loaderFor('tetris') }));
  }, /two cartridges named "tetris"/);
});

test('adding after build, building twice, and building empty are all refused', async () => {
  const reg = await bothGames();
  assert.throws(() => reg.add({ name: 'x', methods: {} }), /already built/);
  await assert.rejects(() => reg.build(tokenize), /already built/);

  const empty = new CartridgeRegistry();
  await assert.rejects(() => empty.build(tokenize), /nothing to build/);
});

test('a single-cartridge registry matches building that cartridge alone', async () => {
  // The registry must not change what one cartridge means on its own —
  // otherwise migrating a demo to it would silently alter the grammar.
  const alone = new Cartridge(await manifestFor('tetris'), { loadSchema: loaderFor('tetris') });
  await alone.build(tokenize);

  const reg = new CartridgeRegistry();
  reg.add(new Cartridge(await manifestFor('tetris'), { loadSchema: loaderFor('tetris') }));
  await reg.build(tokenize);

  assert.deepEqual(
    reg.trie.opcodes.map(o => o.string),
    alone.trie.opcodes.map(o => o.string),
  );
  assert.deepEqual([...reg.allMethodIndices()].sort(), [...alone.allMethodIndices()].sort());
  assert.deepEqual([...reg.haltIndices()].sort(), [...alone.haltIndices()].sort());
});
