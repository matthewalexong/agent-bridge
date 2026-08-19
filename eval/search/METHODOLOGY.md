# North Star methodology — how we know the "correct answer" is correct

**Problem.** The search-eval ground truth is produced by our own judge code
(`lib/search-judge.mjs`). If the judge is wrong, every score we celebrate is
worthless. A North Star is only a North Star if an *independent* competent
agent looking at the same page would make the same call. This document is the
methodology for validating that, and it doubles as the procedure for the next
time the corpus or the judge changes.

## The three layers

### Layer 1 — Internal consistency (generator self-verification)

`gen-random-tasks.mjs` generates each scenario so the intended ground truth is
*entailed by construction* (exactly one listing can satisfy all constraints,
or none can, etc.), then runs the judge over the generated snapshot and
asserts the judge's verdict matches the construction. Catches wiring bugs in
the generator/judge pair. It proves nothing about *policy* — only that the
parts agree with each other.

### Layer 2 — Blind frontier adjudication (the North Star check)

`adjudicate-random.mjs` asks the frontier model (via `cascade/lib/frontier.mjs`
→ Hermes main-model endpoint; **not** local Gemma, so independence is real)
to decide each task with the verdict hidden:

- input: raw query, constraints (rendered as human-readable text — **never**
  raw JSON objects, see Pitfalls), and the listing snapshot.
- asked to output: `buy[<letter>]` or `reformulate`.
- the judge's verdict is mapped to the same vocabulary (`stop`→`buy`) and
  compared on **action + listing letter**.

Rules of the check:

1. **Stratified sample.** One task per scenario type first, then fill by
   round-robin, seeded (`--seed`). Scenario type is parsed from the filename
   (`rand-N-<scenario>.json`), not a top-level field.
2. **Every disagreement is triaged, never ignored.** The escalation ladder,
   in order:
   - a) **harness bug** in the adjudicator itself (bad prompt rendering,
     vocabulary mismatch, wrong field) → fix harness, re-run;
   - b) **generator bug** (task is genuinely ambiguous/mislabelled — the
     frontier is *right* and the judge is blind) → fix generator, regenerate;
   - c) **judge-policy bug** → fix judge, re-run;
   - d) genuine **policy disagreement** between two competent agents →
     human decision, then encode it explicitly in both the judge and the
     adjudicator prompt so future runs are consistent.
3. **Evidence persists.** Results are written per seed
   (`adjudication-results-seed<N>.json`) so a later run can't silently
   overwrite earlier evidence.
4. **Two seeds minimum** before a corpus is declared validated (one pass can
   be sample luck).

### Layer 3 — Skill measurement on the validated corpus

Only after Layer 2 passes: run `run-search-eval.mjs` (Gemma transcribes,
judge decides, `EVAL_RUNS=3` median) on the same corpus. The score now means
something — it measures the skill against an externally-validated North Star.

## Current state (2026-08-19)

- Corpus: `tasks-random/`, 40 tasks, seed 1337, all 10 scenario types.
- Layer 1: generator self-verification passes on generation.
- Layer 2: **40/40 blind agreement** — seed 7 (20 tasks) and seed 42 (20
  tasks), all scenario types covered. Evidence:
  `adjudication-results-seed7.json`, `adjudication-results-seed42.json`.
- Layer 3: v6 skill = **98.2%** (38/40 perfect, 3-run median).

## What the process caught (worked examples)

- v1 run scored 26.7% agreement — **entirely harness bugs**: constraints
  rendered as `[object Object]` (frontier judged blindfolded), `stop` vs
  `buy` vocabulary mismatch, wrong listing-id field. Lesson: check the
  harness wiring before concluding a capability wall.
- v2 scored 80% — the 3 real disagreements all had **one root cause**: the
  generator drew the query's product-type prefix independently of listing
  titles, so the judge could legitimately "buy" a Mass Gainer for a
  Whey-Protein query (product type is not an encoded constraint). The
  frontier correctly refused. Fixed by pinning one product type per task
  across the query and matchable listings.
- v3/v4: 100%, confirmed on a second seed.

## Known residual (next skill target, not a North Star problem)

`rand-*-missing-reviews`: Gemma occasionally drops a listing's **price**
during transcription; the judge sorts unknown prices last, which silently
flips the price tiebreak. The North Star verdict is right there — Gemma
missed it. This is the concrete next improvement target for the loop.

## Pitfalls

- Never render constraint objects raw into a prompt (`String(obj)` →
  `[object Object]`). Always human-readable text.
- The judge says `stop`; the frontier vocabulary is `buy`. Map before
  comparing.
- Task files carry no top-level `scenario`; parse it from the filename.
- Regenerating the corpus with a new seed leaves stale files — the generator
  now deletes `rand-*` before writing, but verify the count afterwards.
- Adjudication must use the frontier endpoint, never local Gemma, or the
  check is circular.
