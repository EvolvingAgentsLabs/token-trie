# token-trie — Development Guide

> [!WARNING]
> **Sections 3 and 5 below describe files that do not exist.** They list
> `mobile/src/lib/kernel/`, `runner.ts`, `v2_adapter.ts`, `wllama_*.ts` and a
> `kernel-mode/` demo. Those landed in PRs on 2026-05-05 and were deleted hours
> later by the pivot commit the same day. `mobile/src/` contains exactly four
> files: `App.svelte`, `main.ts`, `app.css`, `components/GamesLauncher.svelte`.
>
> The live kernel is at `mobile/public/demos/_kernel/`. Verify on disk before
> trusting any path in this document.
>
> The repo was renamed from `skillos_mini` to `token-trie` on 2026-07-24.
> See [PLAN.md](PLAN.md) for what is actually being built next.

---



> **Read this file at the start of every work session.**
> It is the source of truth for *why* we are building, *what* we are building, and *what not to build*. If this guide and the code disagree, this guide wins. If this guide and a user request disagree, escalate to Matias before proceeding.

---

## 1. Mission

`skillos_mini` is a **games-first browser playground for the LLM-OS kernel**. It demonstrates that a 350M-parameter LLM can drive interactive programs (games) through a grammar-enforced ISA when paired with a planning-rich Program layer. It hosts the kernel ([`mobile/src/lib/kernel/`](mobile/src/lib/kernel/), vendored from `llm_os/kernel/`), bundles the game demos as static assets, and adds the new **Strategy Markdown Cartridge** abstraction — markdown files that contain prose strategy guidance for each game, picked by the user before play and injected into the system prompt.

The repo's purpose is **demonstration and validation**, not commercial vertical delivery. It is the user-facing companion to [`llm_os`](https://github.com/EvolvingAgentsLabs/llm_os) — same kernel, richer UX, ships in a browser tab.

## 2. Strategic context (why this, why now)

- **April 2026**: Anthropic shipped Agent Skills as a first-class concept. Google AI Edge Gallery shipped Agent Skills on-device with Gemma 4. The SKILL.md format is now an industry standard. Markdown-as-runtime is broadly accepted.
- **Our differentiator**: the kernel pattern. Token-trie grammar enforcement at sample time; Program-layer planning that makes a 350M model viable. Other markdown-skill ecosystems trust the LLM to behave; we make misbehavior physically impossible at the decoder level.
- **Strategy markdown cartridges** is our shape of "user-authored knowledge that steers a sealed runtime". The user picks a strategy ("conservative Tetris", "well-filler Tetris", "cautious Scavenger"), the prose is loaded into the system prompt, the model plays accordingly. It's the smallest possible markdown-cartridge demonstration that's still meaningful.
- **The trade-app vertical (electricista, plomero, pintor) is archived as of 2026-05-05**. It was the prior commercial thesis; the pivot to games-first removed it. See §13 decision log.

## 3. Scope (what is in, what is out)

### In scope

- The two browser demos (Tetris, Scavenger) bundled at [`mobile/public/demos/`](mobile/public/demos/) — same content as `llm_os/demo/{tetris-browser,scavenger-browser}/` but vendored.
- The kernel module at [`mobile/src/lib/kernel/`](mobile/src/lib/kernel/) — vendored from `llm_os/kernel/`.
- A games-first Svelte landing page that lets the user pick a game + strategy and launches the demo in a new tab with the strategy slug as a URL param.
- Strategy markdown cartridges at [`strategies/{tetris,scavenger}/*.md`](strategies/) — each with frontmatter (target, id, name, description) + prose strategy guidance.
- The wllama runtime ([`mobile/src/lib/llm/local/wllama_*`](mobile/src/lib/llm/local/)) — same model loader the demos depend on.
- The `KernelRunner` module ([`mobile/src/lib/kernel/runner.ts`](mobile/src/lib/kernel/runner.ts)) — multi-turn dispatch loop, used by the kernel-mode runner demo.

### Out of scope (explicit)

- **No trade verticals.** Electricista/plomero/pintor are deleted. Do not re-add them.
- **No backend.** Demos run entirely in the browser.
- **No cloud LLMs.** Local-only via wllama.
- **No vision cartridge backends.** Vision was a trade-app utility; with trade scrapped, vision integration is out.
- **No Capacitor / no Android / no PWA distribution.** Browser tab is the entire product surface.
- **No CartridgeRunner / blackboard / validators / schema-driven UI.** All deleted with the trade-app code.
- **No agentic Recipe loops.** The games are the recipes. Strategy markdown is the only authoring surface.
- **No iframe Skill sandbox / no Gallery skills.** Deleted.
- **No model-management UI / no model store / no provider-settings UI.** Hardcoded LFM 2.5 350M.

## 4. Architectural principles (Non-Negotiable)

### 4.1 Kernel is sacred

The kernel ([`mobile/src/lib/kernel/`](mobile/src/lib/kernel/)) is vendored from `llm_os/kernel/`. **Don't edit it locally.** All edits go upstream first, then re-vendor (see [`mobile/src/lib/kernel/VENDORED.md`](mobile/src/lib/kernel/VENDORED.md)).

### 4.2 Program-layer-first

Every game demo splits state into:
- **OS layer** (kernel, in JS) — grammar enforcement, dispatch, KV, phase control
- **Program layer** (per-game, in JS) — planning, simulation, scoring, BFS, compiled-state synthesis. Pre-computes options the LLM ratifies.
- **Engine** (per-game, in JS) — game rules

The LLM-CPU is a ratifier, not a planner. If you find yourself making the LLM "decide" something the Program could compute, push it down into the Program.

### 4.3 Strategy cartridges are markdown-only

A strategy is a single `.md` file with YAML frontmatter (`target`, `id`, `name`, `description`) and prose body. The body is the system-prompt addendum. No code, no schemas, no validators. If a strategy needs code to behave correctly, the strategy is wrong — push the logic into the Program layer instead.

### 4.4 Static-asset-first deployment

The games are static HTML+JS at [`mobile/public/demos/`](mobile/public/demos/). They run independently of the Svelte app — the Svelte app is just a launcher. This means the demos are testable directly via `python -m http.server` in `mobile/public/`, with no Svelte build needed.

## 5. Repo layout

```
skillos_mini/
├── CLAUDE.md                          # this file
├── README.md                          # short user-facing
├── TESTING.md                         # how to run the demos end-to-end
├── strategies/                        # NEW — markdown strategy cartridges
│   ├── tetris/{conservative,aggressive,well-filler}.md
│   └── scavenger/{cautious,direct,explorer}.md
└── mobile/
    ├── package.json                   # Vite + Svelte + wllama
    ├── vite.config.ts                 # COOP/COEP plugin
    ├── public/
    │   ├── demos/                     # bundled llm_os games
    │   │   ├── index.html             # demos landing
    │   │   ├── tetris/index.html
    │   │   ├── scavenger/index.html
    │   │   ├── kernel-mode/index.html
    │   │   ├── _kernel/               # vendored kernel snapshot
    │   │   └── _cart/game/            # game cartridge manifests
    │   └── wllama/                    # wllama WASM assets
    └── src/
        ├── App.svelte                 # GamesLauncher root
        ├── main.ts
        ├── app.css
        ├── components/
        │   └── GamesLauncher.svelte   # the ONE Svelte component
        └── lib/
            ├── kernel/                # vendored kernel (do not edit locally)
            │   ├── token_trie.js
            │   ├── cartridge.js
            │   ├── sampler.js
            │   ├── dispatch.js
            │   ├── runner.ts
            │   ├── v2_adapter.ts
            │   ├── wllama_kernel_backend.ts
            │   ├── index.js
            │   └── schemas/cartridge.manifest.schema.json
            └── llm/local/
                ├── wllama_backend.ts  # main-thread façade
                └── wllama_worker.ts   # the actual wllama instance
```

That's it. Anything not in this list was deleted in the games-first pivot.

## 6. Strategy markdown cartridges (the new abstraction)

A strategy is a markdown file:

```markdown
---
target: tetris
id: well-filler
name: Well Filler
description: Build tall on the left, keep column 9 empty for I-pieces.
---

# Well Filler

When you receive `best_actions`, prefer the action that...
```

The launcher reads `strategies/<game>/*.md`, parses frontmatter via `gray-matter`, lists each as a card in the UI. The user picks one; the launcher opens the corresponding demo with `?strategy=<id>` in the URL. The demo fetches `/strategies/<game>/<id>.md`, parses the body, prepends it to its `SYSTEM_PROMPT` before model load.

Strategies don't touch the kernel, the Program layer, or the cartridge manifest. They are **prompt-time customization only**. The grammar still constrains output to valid opcodes regardless of what the strategy says.

## 7. Decision log

| Decision | Date | Rationale |
|---|---|---|
| Mobile-first, on-device | 2026-04 | Frontier opened with Gemma 4; cartridges differentiate |
| Three-trade vertical (electricista/plomero/pintor) | 2026-04 | First commercial thesis |
| Cartridge v2 (markdown + tool library) | 2026-04-29 | Domain experts author cartridges without an engineer |
| **Pivot to games-first LLM-OS playground** | **2026-05-05** | **The kernel pattern is the differentiator. Games are the cleanest demonstration. Trade-app delivery was a longer path; the pivot focuses on the foundation first. Trade verticals archived (deleted from main, recoverable from git history at commit `709104b` or the `feat/llm-os-kernel-integration` branch).** |
| Strategy markdown cartridges | 2026-05-05 | Smallest possible markdown-cartridge demonstration that's meaningful in the games context |
| No backend, no Capacitor, no PWA | 2026-05-05 | Browser tab is the entire surface |

## 8. Guardrails for Claude Code

When working on this repo, stop and ask Matias before:

- Re-adding any trade-app concept (validators, blackboard, CartridgeRunner, schema-driven UI, agentic flows). The pivot intentionally removed these.
- Adding any backend dependency, server, or external API call.
- Editing the vendored kernel locally (always upstream-first).
- Adding a new top-level dependency to `package.json`.
- Re-introducing Capacitor / Android / iOS / PWA targets.
- Adding cloud LLM calls.
- Designing any UI more elaborate than the games launcher described in §5.

When in doubt: ship narrower, stay games-first.

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| Q1 | Do strategy cartridges support per-method overrides (e.g. "force `pickup` whenever `on_target`"), or stay prompt-only? | strategy authoring beyond the first round |
| Q2 | A strategy that depends on the current piece type (Tetris) — is that prompt-only or do we extend the Program layer? | richer Tetris strategies |
| Q3 | Cross-game strategy bundles ("speedrun pack" for both games)? | UI design |

---

*Last updated: 2026-05-05. Pivot from trade-app to games-first ratified by Matias 2026-05-05.*
