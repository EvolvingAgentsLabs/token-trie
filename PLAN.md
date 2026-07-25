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

### 3. Free strings — ✅ **done 2026-07-25** (and still the reason to be sceptical)

`{"type":"string"}` with no enum has no finite trie. Constraining it means a different
mechanism: allow any token except the structural ones, bounded by a length cap and a
terminator, with the trie resuming after the closing quote.

Two things to know before starting. First, this is where "grammar-enforced" gets weaker —
you are constraining the *shape*, not the content, which is what GBNF would also give you
and no more. Second, an agent OS whose tools take free strings is most of an agent OS, so
this phase decides whether the project generalises or stays a games demo. **Do not
promise phase 3 before phase 2 lands.**

### 4. `CartridgeRegistry` — ✅ **done 2026-07-25**

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

## Phase 3 — done, with the caveat intact

`{"type":"string","maxTokens":N}` compiles to a **slot**: a trie node that
accepts any token whose text does not break out of the JSON string, up to a cap,
exiting on the closing quote.

**The architecture had to bend, and it is worth naming where.** Everything else
in the trie is token IDs, so the valid-next set is `node.children.keys()`. A slot
has no such set — membership depends on what a token *says*, which means
detokenizing it, which is async and belongs to the backend. So
`getValidNextTokens` now returns either a `Set` or a `SlotConstraint`, and the
sampler resolves the latter by decoding each top-K candidate (cached) and
testing it. That is the one place the trie stops being purely token-level.

**What the slot guarantees:** the model cannot close the string early, cannot
emit a raw newline or backslash, and cannot run past its cap. When nothing
usable is in top-K it closes the string rather than guessing at content — the
only fallback that stays grammatical.

**What it does not guarantee, and this is the caveat this section always
carried:** inside the slot the grammar constrains *shape*, not *content*. What
the model writes in there is its own. That is exactly what GBNF would give, and
no more. `Sampler.generate` now returns `slotTokens` alongside `fellBackSteps`
so a caller can see how much of an output was shaped rather than chosen.

**Limits, deliberate:** one free string per method — with two, nothing marks
where the first ends, and a method wanting two is two methods. And `maxTokens`
is required rather than defaulted, because an uncapped slot is one the model can
sit in until its budget runs out, and that decision should be written down.

## Phase 4 — done

Several cartridges share one trie. Tetris and Scavenger together: 14 method
opcodes, 3 halt, 17 total.

**Almost nothing was needed, and that is the point of having gated it.** The
wire format already carries the cartridge name — `<|call|>tetris.move …` versus
`<|call|>scavenger.move …` — so two cartridges land on different branches with
no disambiguation, and `dispatch.js` parses the name back out unchanged. The
work was `Cartridge.buildInto(trie, …)` plus a registry holding the phase-control
sets.

**Halt opcodes are deduplicated.** Every cartridge declares the same three by
default; inserting a private copy each would put indistinguishable
`<|halt|>status=success` opcodes in one trie and force phase control to carry
all of them to mean "may halt".

**Method names are qualified.** `methodIndices("tetris.move")`, not `"move"` — a
registry can hold two cartridges that both define `move`, and an unqualified
name would silently pick one. Refused rather than resolved.

A test asserts a single-cartridge registry produces exactly what building that
cartridge alone produces, so moving a demo onto the registry cannot quietly
change its grammar.

## Phase 5 — one kernel, two frontends

The four phases above made the kernel general. This one points it at the thing
that needs it.

### The finding that motivates it

`skillos_robot` and this repo emit **the same wire format**. Not similar — the
opcode regex is character-for-character identical in both:

```
/<\|call\|>([a-zA-Z_][\w-]*)\.([a-zA-Z_][\w-]*)\s*([\s\S]*?)\s*<\|\/call\|>/
```

They were one codebase. What diverged is enforcement. This repo masks the
sampler so malformed output is unreachable. The robot asks in the prompt, caps
generation with stop sequences, and parses with that regex — the arm we measured
and found unreliable.

**It fails, and there is a recording.** On 2026-07-24, driving the 2D simulator
against a Google model, one run produced **28 consecutive `unknown` opcodes**
after the provider capped stop sequences from fourteen to five. The model chained
instructions and the parser could not follow. Nothing was constrained; something
was requested and then checked.

So the validated mechanism runs a Tetris demo in a browser tab, and the
unvalidated one drives motors. That is backwards, and it is the whole reason
this phase exists: a malformed JSON in a chatbot is a retry, a malformed motor
command is a robot hitting something.

### The blocker, which is also the point

The trie needs `getLogits` — per-token probabilities at each step. The robot's
backend has **zero** references to logits, because it talks to cloud APIs that do
not expose them.

Putting the trie behind the robot therefore **forces a local model**. That is not
an obstacle to route around; it is the position this work already argues for, and
it turns "on-device" from a preference into a technical requirement.

The kernel is five dependency-free ES modules and already runs under Node, which
is where the robot lives. Nothing needs porting.

### Week of 2026-07-27 — the concrete tasks

**1 · A cartridge for the robot's ISA** *(~half a day)*

Write `_cart/io/robot/manifest.json` declaring the six methods the robot exposes
— `navigate`, `observe`, `describe`, `speak`, `listen`, `stop` — as `args_schema`
files. After phases 1–3 this means writing schemas, not opcode strings: enums for
the fixed choices, bounded integers for distances and headings, and a slot for
`speak`'s free text.

*Done when:* every opcode the compiler emits is accepted by `skillos_robot`'s
`parseOpcode` regex. Assert it in a test rather than reading them.

**2 · A local backend that exposes logits** *(~1 day, the real unknown)*

The `Backend` interface needs seven methods; the one that decides everything is
`getLogits(idx) → Array<{token, p}>`. Candidates in order of expected effort:
wllama under Node, a `llama.cpp` server with `n_probs`, or an FFI binding.

*Done when:* a local runtime returns per-token probabilities **and** its
tokenizer treats `<|call|>` and `<|halt|>` as single tokens. Check the second
part first — it is the one that fails.

**3 · Wire the sampler in** *(~1 day)*

Replace the orchestrator's `generate()` with `Sampler.generate()`, keeping the
cloud path behind a flag so a bad week does not leave the robot unusable.

*Done when:* a full simulator run completes with the trie in the loop.

**4 · Measure it against the failure we already have** *(~half a day)*

This step is why the recording matters. Run the same scenario N times on both
paths and compare **unparseable-opcode rate**. The cloud+regex baseline is on
record at 28 in a single run. The trie's floor is structurally zero — it cannot
emit an opcode that is not in the trie — so the interesting number is not that
one but `fellBackSteps`: how often nothing valid appeared in top-K and the
sampler had to pick without the model's opinion.

*Done when:* both numbers are written down. A trie run with a high
`fellBackSteps` is syntactically perfect and strategically blind, and reporting
only the zero would be the same mistake as reporting only positive results.

### Risks, named in advance

**The tokenizer is the one that can stall this.** Only LFM 2.5 is validated to
treat the markers as single tokens; Qwen and Gemma split them, the trie's valid
set stops intersecting top-K, and the sampler falls back to a deterministic
non-choice. If no local candidate passes step 2, this phase stops there and the
real work becomes the special-token migration — a different project, and worth
knowing by Tuesday rather than Friday.

**Latency is probably fine and should still be checked.** The 20 Hz motor loop is
the reactive controller, not the model; the model plans at roughly 1 Hz. Local
inference makes that slower, not the control loop.

**What this does not touch:** the Program layer. A hand-written planner still
does the planning and the model ratifies a ranked list. Phases 1–5 do not move
that, and a phase that claimed to would be lying.

## All four phases are done

What began as a hand-written list of complete instruction strings is now
compiled: enums and bounded integers enumerate, free strings become slots, and
several cartridges share one trie.

**The limit that none of this moved** is the one at the top of this document:
the Program layer still does the planning. Tetris works because a Dellacherie
scorer ranks all forty placements and the model picks from the ranked list. That
was true before phase 1 and it is true now. If the next thing you want is for
the model to plan, no amount of grammar work gets you there — that is a
different project, and the honest pitch remains *grammar-safe on-device
execution of pre-planned skills*.

Two smaller things left on the table, both noted where they arise: Tetris still
exposes `move {"action": …}` rather than the `place {"column":…,"rotation":…}`
that phase 2 unlocked, and no demo uses the registry yet. Both change a game
rather than the kernel, so they are their own work.

### Not done, and not part of phase 2

Tetris still exposes `move {"action": "left"|"right"|...}`. Giving it
`place {"column":…,"rotation":…}` would shrink the Program layer, which is the
reason the phase exists — but it changes the engine and the demo, so it is its
own change with its own test, not a rider on the compiler.
