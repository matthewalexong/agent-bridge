# Cascade — token-frugal recursive improvement for agent-bridge

A local-first improvement loop that offloads as much work as possible to the
local Gemma 4 E2B (llama.cpp server on `127.0.0.1:8080`, on-demand via
launchd) and only escalates to a frontier model when a deterministic verifier
proves the local model is stuck.

## Why this shape

Empirically measured on this machine (see `../bench/`):

| Capability | Local Qwen3.8-9B Q4_K_M |
|---|---|
| Well-specified code tasks (execute a clear spec) | ✅ first-try, ~10–16 tok/s |
| Discovering an optimization insight | ❌ needs insight handed to it |
| Executing a handed strategy exactly | ⚠️ fails on details |
| Self-correcting from test feedback | ❌ repeats identical wrong output |

So the local model is a **worker pool, not the driver**. Ground truth is always
the deterministic verifier (it executes the code), never a model's opinion.

## The cascade

```
task spec ──► local attempt 1 ──► verifier ──pass──► DONE (0 frontier tokens)
                  │ fail (exact verifier output folded back in)
                  ▼
             local attempt 2 ──► verifier ──pass──► DONE
                  │ fail
                  ▼
             local attempt N ──► verifier ──pass──► DONE
                  │ fail (local exhausted)
                  ▼
             ONE frontier CONSULT — diagnosis + algorithm only, NOT full code
             (the gateway hard-caps frontier output at ~8K tokens, so a full
              implementation gets truncated mid-function and wastes the whole call)
                  │
                  ├──► (if consult includes a code block) verifier ──pass──► DONE
                  │
                  └──► local IMPLEMENTS the diagnosis, verifier closes the loop
                        (consultant thinks, worker types — cheapest possible frontier use)
```

Key properties:

- **Feedback mutation**: every failed attempt's *exact verifier output* (assertion
  errors, byte mismatches, stack traces) is appended to the local conversation,
  so retries are informed, not blind.
- **Single frontier consult, diagnosis-only**: escalation asks for the bug
  diagnosis + algorithm + edge cases in under 1500 words — never a full
  implementation (gateway caps output at ~8K tokens and would truncate it).
  Frontier is a consultant, not a worker.
- **Local implements the diagnosis**: the local model codes the frontier's
  algorithm; local is a competent editor when given a correct spec.
- **Truncation-aware extraction**: an unclosed ``` fence (truncated response)
  still yields its partial code for verification.
- **Ledger**: every call (tier, prompt/gen tokens, latency) lands in
  `ledger.jsonl`; the summary prints actual frontier spend vs the
  frontier-only counterfactual (the savings math).

Dev escape hatch: `CASCADE_SKIP_LOCAL=1` jumps straight to the frontier consult
(for iterating on the escalation path without re-running local attempts).

## Layout

```
cascade/
├── run.mjs              # CLI + task definitions
├── ledger.jsonl         # append-only call accounting (gitignored)
└── lib/
    ├── cascade.mjs      # the loop above
    ├── local-worker.mjs # llama.cpp client + code-block extraction + health check
    ├── frontier.mjs     # reads hermes config for endpoint/key/model; probes both
    │                    #   <base>/v1/messages and <base> (gateway shape varies)
    ├── verifier.mjs     # sandboxed node --check + behavioral test execution
    └── ledger.mjs       # JSONL accounting + savings math
```

## Usage

```bash
node cascade/run.mjs --list                    # available tasks
node cascade/run.mjs                           # all tasks
node cascade/run.mjs --task bounded-error-class
FRONTIER_RATE_IN_PER_MTOK=2.5 FRONTIER_RATE_OUT_PER_MTOK=10 node cascade/run.mjs
```

Environment overrides: `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`.

## Adding a task

A task is `{ id, prompt, maxTokens, frontierMaxTokens?, verify }` where
`verify = makeVerifier(testScriptBody)` — the test body imports `* as candidate`
and asserts behavior with `node:assert`. The verifier is the contract: if you
can't write a deterministic test for it, it doesn't belong in the cascade.

## Results (2026-08-18)

| Task | Outcome | Frontier cost |
|---|---|---|
| bounded-error-class | local-solved, attempt 1 | $0 |
| bounded-ring-deque | local-solved, attempt 1 | $0 |
| trace-byte-walker | local failed (recursion + accumulation bugs) → frontier-guided local repair → **converged, all 9 correctness checks pass** | one 3.4K-token consult |

Two of three real tasks solved with **zero frontier tokens**. The third needed
exactly one compact consult plus guided local repairs — and surfaced a genuinely
useful engineering finding along the way: **V8's native JSON.stringify beats any
pure-JS byte-walker (~0.42x), so this hot path needs an architectural fix
(batch accounting), not a rewrite.** That is precisely the class of decision the
cascade is designed to escalate.

### What the escalation path proved (empirically, not theoretically)

1. Local model alone: same byte-accounting bug (overwrite instead of accumulate)
   on every attempt — could not self-correct from raw verifier output.
2. With the *exact* insight injected ("use +=, never ="): local produced correct
   code, then hit a recursion bug, then a type-coercion bug (`ch < 0x20` treats
   digit strings as control chars) — each one fixed in one repair round when the
   verifier's exact error was fed back.
3. Total frontier spend on the hard task: **one consult, ~3.4K tokens (~$0.03)**.

## TASK 4 — improve-extract-facts-skill (extract-then-judge, recursive)

The flagship recursive task, driving the Agent Bridge browsing skill itself:

```
Gemma extracts raw FACTS from a page snapshot (price, scoop size, servings…)
        │  pure transcription — no arithmetic, no judgment
        ▼
eval/lib/judge.mjs (pure code): unit normalization, derived economics,
        misleading-claim verdict, templated explanation
        ▼
deterministic scorer vs ground truth  →  OVERALL %
```

Ground truth is sandboxed eval execution, never model self-report. **All
judgment and arithmetic live in code**; the only knob the loop can turn is
the skill markdown. Proven capability walls (why judgment left the model):

- Gemma extracted every fact perfectly yet still made the wrong misleading-
  claim call — inference ≠ extraction. Judgment moved to `judge.mjs`.
- Gemma cannot divide by 1000 even with an explicit "convert MG to grams"
  instruction (proven twice: cascade loop + manual replication). Unit
  normalization moved to `judge.mjs` too (explicit-unit path + plausibility
  fallback; the fallback deliberately ignores moderate deceptive claims like
  "1250G" so the misleading rules can still flag them).

Loop properties: starts from the highest-numbered skill (compounding),
baseline measured live each run (skip-gated on the parsed score, not on
"no failure lines" — a crashed task must never read as perfect), winner
persisted as the next version number. Verifier: `eval/verify-skill.mjs`
(threshold 98%, rejects skills that hardcode task IDs/product names).

### TASK 4 results (2026-08-18/19)

| Corpus | Best skill | Score |
|---|---|---|
| 3 original tasks | v1 (frontier-guided) | 100% |
| 6 tasks (+fractional, headline-vs-panel, metric) | v2 | 100% |
| 7 tasks (+mg-units, unit normalization in judge) | v2 | 100%, holds at temp 0.3 |

One frontier consult (~4K tokens, ~$0.03) produced the v1→v2 insight; Gemma
implemented it. The loop then correctly self-gated at 100% with **zero
tokens spent** — that is the architecture policing itself.

## TASK 5 — improve-search-transcribe-skill (search disambiguation, recursive)

The Agent Bridge search-skill proper: **listing disambiguation** and **knowing
when a search is "enough"**. Same extract-then-judge shape:

```
Gemma transcribes SERP listings (brand, flavor, size+unit, protein+unit,
        stock, sponsored) — pure transcription, no decision-making
        ▼
eval/search/lib/search-judge.mjs (pure code): unit normalization (kg/lb/g/mg),
        constraint matching (exact brand/flavor, relative size tolerance),
        verdict: stop+select (prefer organic over sponsored twins)
        | reformulate (no full match / full match but out of stock)
        ▼
deterministic scorer vs ground truth  →  OVERALL %
```

Corpus (`eval/search/tasks/`, 9 synthetic SERPs): near-twin size traps,
sponsored-vs-organic twins, out-of-stock full matches, mg protein claims,
contradictory title-vs-field, missing fields, brand-variant twins
("MuscleMax" vs "MuscleMax Pro"), mixed kg/lb/g units. Every task's ground
truth was machine-verified against the judge's own rules before use.

Loop properties are identical to TASK 4: compounding versions, live-grounded
baseline, score-gated skip (never "no failure lines"), anti-cheat guard.
Both tasks share one factory (`makeSkillTask`) in `run.mjs` — adding a third
recursively-improved skill is a ~10-line registration.

### TASK 5 results (2026-08-19)

| Corpus | Best skill | Score |
|---|---|---|
| 9 search tasks | v1 | 100%, holds at temp 0.3 |

Two apparent failures during corpus construction were bugs in the *scorer*
(`numEq(null, null) === false` penalized correct missing-field transcription;
`""` vs `null` unit encodings) — fixed, and the model was right all along.
That is the discipline this architecture enforces: the first explanation for
a failure is always checked against the judge itself.
