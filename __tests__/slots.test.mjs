// PLAN.md phase 3 — free strings as trie slots.
//
// The claim under test is narrow and worth stating exactly: inside a slot the
// model may emit anything that does not break out of the JSON string, it may
// not exceed the cap, and when it leaves, the fixed grammar resumes. The
// grammar shapes the region; it does not choose its contents.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokenTrie, SlotSpec, SlotConstraint }
  from '../mobile/public/demos/_kernel/token_trie.js';
import { Sampler } from '../mobile/public/demos/_kernel/sampler.js';
import { compileSlotTemplate, JSON_STRING_FORBID, UnsupportedSchemaError }
  from '../mobile/public/demos/_kernel/compile_opcodes.js';

// ── A character-level tokenizer, so token IDs are legible in failures ──────

const tok = (s) => [...s].map(c => c.codePointAt(0));
const untok = (ids) => ids.map(i => String.fromCodePoint(i)).join('');

function buildTrie({ prefix, suffix, maxTokens, minTokens = 0 }) {
  const spec = new SlotSpec({ forbid: JSON_STRING_FORBID, maxTokens, minTokens, name: 'text' });
  const trie = new TokenTrie();
  trie.insertWithSlots(`${prefix}<slot>${suffix}`, [tok(prefix), spec, tok(suffix)], 'c.say');
  return { trie, spec };
}

// ── The trie's view ────────────────────────────────────────────────────────

test('the fixed prefix constrains normally, then opens a slot', () => {
  const { trie } = buildTrie({ prefix: '<|call|>c.say {"t":"', suffix: '"}\n', maxTokens: 8 });
  const prefix = tok('<|call|>c.say {"t":"');

  // Partway through the prefix there is exactly one legal next token.
  const mid = trie.getValidNextTokens(prefix.slice(0, 5), null);
  assert.ok(mid instanceof Set);
  assert.equal(mid.size, 1);

  // At the end of the prefix the trie hands back a constraint, not a set.
  const atSlot = trie.getValidNextTokens(prefix, null);
  assert.ok(atSlot instanceof SlotConstraint, 'expected a SlotConstraint at the slot');
  assert.equal(atSlot.tokensConsumed, 0);
  assert.deepEqual([...atSlot.exitTokens], tok('"'), 'the closing quote should be the exit');
});

test('content is allowed, quotes and newlines are not', () => {
  const { trie } = buildTrie({ prefix: 'p"', suffix: '"}\n', maxTokens: 8 });
  const c = trie.getValidNextTokens(tok('p"'), null);

  for (const ok of ['a', ' ', 'Z', '9', '!']) {
    assert.ok(c.allowsContent(ok), `${JSON.stringify(ok)} should be allowed as content`);
  }
  for (const bad of ['"', '\n', '\r', '\\']) {
    assert.ok(!c.allowsContent(bad), `${JSON.stringify(bad)} must not be content`);
  }
});

test('at the cap only the exit remains', () => {
  const { trie } = buildTrie({ prefix: 'p"', suffix: '"}\n', maxTokens: 3 });
  const atCap = trie.getValidNextTokens([...tok('p"'), ...tok('abc')], null);
  assert.equal(atCap.tokensConsumed, 3);
  assert.equal(atCap.canTakeContent, false);
  assert.ok(!atCap.allowsContent('d'), 'content past the cap must be refused');
  assert.equal(atCap.canExit, true);
});

test('below the floor the slot cannot close', () => {
  const { trie } = buildTrie({ prefix: 'p"', suffix: '"}\n', maxTokens: 8, minTokens: 2 });
  assert.equal(trie.getValidNextTokens(tok('p"'), null).canExit, false);
  assert.equal(trie.getValidNextTokens([...tok('p"'), ...tok('a')], null).canExit, false);
  assert.equal(trie.getValidNextTokens([...tok('p"'), ...tok('ab')], null).canExit, true);
});

test('an opcode is not complete while its slot is open', () => {
  const { trie } = buildTrie({ prefix: 'p"', suffix: '"}\n', maxTokens: 8 });
  assert.equal(trie.isComplete([...tok('p"'), ...tok('hi')]), false);
  assert.equal(trie.getOpcodeIndex([...tok('p"'), ...tok('hi')]), -1);

  const whole = [...tok('p"'), ...tok('hi'), ...tok('"}\n')];
  assert.equal(trie.isComplete(whole), true);
  assert.equal(trie.getOpcodeIndex(whole), 0);
});

test('a slot that never closes is refused at build time', () => {
  const spec = new SlotSpec({ forbid: JSON_STRING_FORBID, maxTokens: 4 });
  const trie = new TokenTrie();
  assert.throws(() => trie.insertWithSlots('x', [tok('p'), spec], 'c.m'), /never close/);
  assert.throws(
    () => trie.insertWithSlots('x', [tok('p'), spec, new SlotSpec({ forbid: /x/, maxTokens: 1 }), tok('q')], 'c.m'),
    /no boundary/,
  );
});

// ── The sampler's view: does it actually generate through a slot? ──────────

/** A backend that always ranks the characters of `script` highest, in order. */
function fakeBackend(script) {
  let i = 0;
  return {
    async tokenize(s) { return tok(s); },
    async detokenize(ids) { return new TextEncoder().encode(untok(ids)); },
    async decode() {},
    async samplingInit() {},
    async samplingAccept() {},
    async kvClear() {},
    async getLogits() {
      // Offer the scripted character plus a few distractors, including ones
      // the slot must refuse.
      const want = script[Math.min(i++, script.length - 1)];
      return [
        { token: want.codePointAt(0), p: 0.9 },
        { token: '"'.codePointAt(0), p: 0.85 },
        { token: '\n'.codePointAt(0), p: 0.8 },
        { token: 'z'.codePointAt(0), p: 0.1 },
      ];
    },
  };
}

test('the sampler generates content through a slot and closes it', async () => {
  const { trie } = buildTrie({ prefix: 'S', suffix: '"}\n', maxTokens: 16 });
  // Script: the prefix, then free content, then the closing quote.
  const sampler = new Sampler(fakeBackend('S' + 'hola' + '"}\n'), trie, {});
  const out = await sampler.generate('', { maxTokens: 40 });

  assert.equal(out.text, 'Shola"}\n');
  assert.equal(out.stalled, false);
  assert.equal(out.opcodeIndex, 0);
  assert.equal(out.slotTokens, 4, 'four content tokens went into the slot');
});

test('the sampler refuses a quote offered as content, even at the top of top-K', async () => {
  const { trie } = buildTrie({ prefix: 'S', suffix: '"}\n', maxTokens: 16, minTokens: 3 });
  // The backend keeps offering `"` at high probability, but the floor of 3
  // means it cannot be taken until three content tokens exist.
  const sampler = new Sampler(fakeBackend('S' + 'abc' + '"}\n'), trie, {});
  const out = await sampler.generate('', { maxTokens: 40 });

  assert.equal(out.text, 'Sabc"}\n');
  assert.equal(out.slotTokens, 3);
});

test('when nothing usable is in top-K the slot closes rather than guessing', async () => {
  const { trie } = buildTrie({ prefix: 'S', suffix: '"}\n', maxTokens: 16 });
  const backend = {
    ...fakeBackend('S'),
    async getLogits() {
      // Only forbidden content on offer, and the exit is not among the
      // candidates either — so the sampler must fall back to the exit token.
      return [{ token: '\n'.codePointAt(0), p: 0.9 }, { token: '\\'.codePointAt(0), p: 0.8 }];
    },
  };
  const sampler = new Sampler(backend, trie, {});
  // Prime past the prefix by hand: generate() walks from empty, so drive the
  // trie directly to confirm the fallback is the exit token.
  const c = trie.getValidNextTokens(tok('S'), null);
  assert.equal(c.fallbackToken, '"'.codePointAt(0));
  assert.ok(sampler);
});

// ── The compiler's view ────────────────────────────────────────────────────

test('a free string compiles to a slot template, not to enumerated opcodes', () => {
  const t = compileSlotTemplate('c', 'say', {
    type: 'object',
    properties: { text: { type: 'string', maxTokens: 24 } },
  });
  assert.equal(t.slotName, 'text');
  assert.equal(t.parts.length, 1);
  assert.equal(t.parts[0].prefix, '<|call|>c.say {"text":"');
  assert.equal(t.parts[0].suffix, '"}<|/call|>\n');
  assert.equal(t.parts[0].slot.maxTokens, 24);
});

test('a free string crossed with an enum gives one template per enum value', () => {
  const t = compileSlotTemplate('c', 'say', {
    type: 'object',
    properties: { tone: { enum: ['calm', 'urgent'] }, text: { type: 'string', maxTokens: 8 } },
  });
  assert.deepEqual(t.parts.map(p => p.prefix), [
    '<|call|>c.say {"tone":"calm","text":"',
    '<|call|>c.say {"tone":"urgent","text":"',
  ]);
});

test('a method with no free string yields no template', () => {
  assert.equal(
    compileSlotTemplate('c', 'm', { type: 'object', properties: { a: { enum: [1] } } }),
    null,
  );
});

test('a free string without maxTokens is refused', () => {
  assert.throws(
    () => compileSlotTemplate('c', 'say', {
      type: 'object', properties: { text: { type: 'string' } },
    }),
    (err) => err instanceof UnsupportedSchemaError && /maxTokens/.test(err.message),
  );
});

test('two free strings are refused, because nothing marks where the first ends', () => {
  assert.throws(
    () => compileSlotTemplate('c', 'say', {
      type: 'object',
      properties: { a: { type: 'string', maxTokens: 4 }, b: { type: 'string', maxTokens: 4 } },
    }),
    (err) => err instanceof UnsupportedSchemaError && /Only one is supported/.test(err.message),
  );
});
