# Plan — from enumerated opcodes to constrained arguments

## Where this actually stands

The kernel is 385 lines across five files and it works: a 350M model plays Tetris in a
browser tab and cannot emit invalid syntax, because `token_trie.js` masks the sampler's
valid-next set at every decoding step.

It works because **every legal instruction is written out in full, by hand**, in the
cartridge manifest:

```json
"opcodes": [
  "<|call|>tetris.move {\"action\":\"left\"}<|/call|>\n",
  "<|call|>tetris.move {\"action\":\"right\"}<|/call|>\n",
  "<|call|>tetris.move {\"action\":\"down\"}<|/call|>\n",
  "<|call|>tetris.move {\"action\":\"rotate\"}<|/call|>\n",
  "<|call|>tetris.move {\"action\":\"drop\"}<|/call|>\n"
]
```

Five actions, five strings. The model picks one; the parse is a regex with no JSON repair
and no retry, because the text is guaranteed to be one of those five.

The same manifest also declares `args_schema: "schemas/move.args.schema.json"`, and that
schema is an enum of the same five values. **Nothing reads it.** The kernel's own manifest
schema is candid about this: *"informational; trie enforces enumerated opcodes."*

So the position is: a real constrained-decoding runtime whose grammar is a hard-coded
list. That is fine for a five-action game and it is the ceiling. `move {"x": 37}` cannot
be expressed. Neither can any tool that takes a string.

## What has to be built

The work is to make the trie compile from the schema instead of from the string list.
Four phases, in dependency order, with honest difficulty.

### 1. Enum properties → trie branches — ✅ **done 2026-07-25**

Compile `{"type":"string","enum":[...]}` into the branches the `opcodes` array currently
spells out. Every existing cartridge is expressible this way, so this phase is a pure
refactor with a behavioural test already available: the generated trie must be
byte-identical to the hand-written one.

Deletes the duplication. Changes nothing observable. Do it first because everything else
builds on `schema → trie` being the only path.

### 2. Bounded integers — ✅ **done 2026-07-25**

`{"type":"integer","minimum":0,"maximum":39}` becomes a digit sub-trie. Requires care
about tokenizer behaviour — `37` may be one token or two depending on the model, so the
trie must be built over token IDs, not characters, exactly as opcodes already are.

This is the phase that unlocks a real Tetris move (`{"column": 7, "rotation": 2}`) and
therefore lets the Program layer shrink.

### 3. Free strings — *the hard one, and the reason to be sceptical*

`{"type":"string"}` with no enum has no finite trie. Constraining it means a different
mechanism: allow any token except the structural ones, bounded by a length cap and a
terminator, with the trie resuming after the closing quote.

Two things to know before starting. First, this is where "grammar-enforced" gets weaker —
you are constraining the *shape*, not the content, which is what GBNF would also give you
and no more. Second, an agent OS whose tools take free strings is most of an agent OS, so
this phase decides whether the project generalises or stays a games demo. **Do not
promise phase 3 before phase 2 lands.**

### 4. `CartridgeRegistry` — *mechanical, gated on 1–3*

One trie unifying several cartridges, so a session can hold more than one skill. Straight
extension of `Cartridge.build()`; the reason it is last is that a registry over
hand-enumerated opcodes multiplies the hand-writing problem rather than solving it.

## Two constraints that are not phases

**The tokenizer.** This works on LFM 2.5 because that tokenizer treats `<|call|>` and
`<|halt|>` as single tokens, so the trie's valid-next set lands inside top-K. Qwen and
Gemma split them across several tokens, the intersection usually comes up empty, and
`sampler.js` falls back to `[...validSet][0]` — output stays syntactically valid while the
model stops choosing. It counts these in `fellBackSteps`, which nothing reads.

Fixing this properly means adding the markers to the tokenizer and post-training, which
is a different project. Fixing it cheaply means widening the logit window; try that first
and **read `fellBackSteps`** before believing any result on a new model.

**The Program layer.** In the Tetris demo a hand-written Dellacherie scorer enumerates all
forty placements and ranks them; the model picks from the ranked list. `CLAUDE.md` states
the rule plainly: *"The LLM-CPU is a ratifier, not a planner."*

That is a legitimate finding about what a 350M model can be trusted with, and it is also
the project's real limit: every skill needs a planner written behind it. Phases 1–4 do not
change that. If the pitch is "grammar-safe on-device execution of pre-planned skills", the
architecture supports it. If the pitch is "a small model runs an agent OS", it does not,
and no amount of trie work will make it.

## What to ignore

`llm_os` is archived. Its `v2`/`v3` directories implement all thirteen opcodes but have
**no decode-time enforcement at all** — they constrain with stop sequences and regex over
a cloud model, while the file header claims GBNF passthrough it never had. There is
nothing to port from them except the opcode list, which is already in the ISA spec.

`isa.gbnf` does not exist and never did in any working state; the twelve grammar fixtures
in the old repo were never run through a validator. GBNF is not the target here — the
token trie replaced it deliberately, because wllama's GBNF implementation is broken for
opcode-heavy grammars (upstream #168). That is a feature: it widens the set of usable
backends to anything that exposes per-step token probabilities.

## Phase 1 — done

- ✅ `Cartridge.build()` reads `args_schema` and produces the trie, via
  `_kernel/compile_opcodes.js`.
- ✅ The `opcodes` arrays are gone from both manifests — seven methods across
  the two cartridges now declare only `args_schema`.
- ✅ `__tests__/compile_opcodes.test.mjs` asserts the compiled output is
  byte-identical to the hand-written lists, and that a trie built from the
  schema matches one built from those lists. 8 tests, `node --test`.
- ✅ Verified in the browser: fetching the schema over HTTP and compiling
  produces the same ten opcodes (seven methods + three halt) as before.

An explicit `opcodes` array is still honoured and now takes precedence. That is
deliberate: it is the escape hatch for a method the compiler cannot express, so
adding one is never blocked on phase 3 landing.

## Phase 2 — done

Integers carrying both bounds now compile, with `multipleOf` as an optional
step. `{"column": 0..9, "rotation": 0..3}` — the example this phase was written
for — produces 40 opcodes that branch into exactly ten at the column digit.

**The digit sub-trie is real, and there is a test that says so.** `TokenTrie`
merges common prefixes on insert, so forty integers cost forty leaves under one
stem rather than forty independent strings. `__tests__` asserts the stem never
branches and that all ten digits meet at the same node — if that ever stops
holding, enumeration stops being a reasonable way to spend memory and the test
fails rather than the load quietly getting slower.

**What is refused, deliberately:** an integer missing either bound (no finite
enumeration, and inventing a bound would silently constrain the model to
something nobody wrote down), an inverted range, a `multipleOf` admitting no
value, and any product over `MAX_OPCODES_PER_METHOD` (512) — checked before
building, so a wide product fails fast instead of allocating its way there.

That ceiling is the honest limit of enumeration. Every opcode costs one async
`tokenize` call at cartridge build, so a wide range becomes a stall before the
first move. Past it the answer is a real trie slot — a node accepting any digit
and looping — which is the same machinery phase 3 needs and belongs there.

**Next: phase 3, free strings.** Read that section again before starting; it is
where "grammar-enforced" gets weaker, and it decides whether this generalises
past games.

### Not done, and not part of phase 2

Tetris still exposes `move {"action": "left"|"right"|...}`. Giving it
`place {"column":…,"rotation":…}` would shrink the Program layer, which is the
reason the phase exists — but it changes the engine and the demo, so it is its
own change with its own test, not a rider on the compiler.
