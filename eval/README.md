# Agent Bridge skill evaluation — extract-then-judge

This directory measures whether Agent Bridge's cognitive skills (searching,
extracting, verifying, stopping) are actually getting better.

## The architecture (final)

Every browsing skill is split into two layers with a hard boundary:

    frozen page snapshot ──> GEMMA (local, free) ──> raw FACTS (JSON)
                                                       │
                                    judge.mjs (pure code, free) ──> derived numbers,
                                    ALL arithmetic + ALL judgment     verdicts, scores

- **Gemma extracts facts only.** It never compares, computes, or judges.
  Its output is raw numbers: `headline_protein_g`, `protein_per_scoop_g`,
  `scoops_per_serving`, `servings_per_container`, `net_weight_g`, `price_usd`.
- **judge.mjs computes everything else** deterministically: per-gram cost,
  total protein, and the `misleading_claim` verdict. No LLM, no tokens,
  no variance — an extraction fix automatically repairs every downstream
  judgment.
- **Why:** Gemma was proven unable to make the judgment call itself
  (v1 "extract-verify" skills extracted the facts perfectly but still
  returned the wrong verdict on every trap task, across 7 prompt variants).
  Capability wall, not a prompt problem. So judgment was moved into code.

## The loop

    node cascade/run.mjs --task improve-extract-facts-skill

1. Run a live baseline eval of the current best skill (`extract-facts-vN.md`,
   highest number wins).
2. If it already scores 100% → **skip** (no headroom; add harder tasks first).
3. Otherwise Gemma proposes a minimally-edited skill, grounded in the actual
   per-field failures measured in step 1.
4. The deterministic eval scores the candidate. ≥98% → winner persisted as
   `extract-facts-v(N+1).md`. Failures fold back into Gemma for up to 3 attempts.
5. Only if Gemma exhausts itself does ONE frontier consult diagnose the
   failure; Gemma then implements the diagnosis locally.

## Layout

    eval/
      run-eval.mjs          ← extract-then-judge harness
      lib/judge.mjs         ← ALL arithmetic + judgment (code, not model)
      verify-skill.mjs      ← deterministic verifier used by the cascade
      skills/extract-facts-v*.md  ← THE ARTIFACT THE LOOP IMPROVES (append-only)
      skills/extract-verify*.md   ← deprecated judgment-in-prompt lineage
      tasks/*.json          ← frozen scenarios + fact-level ground truth
      results/              ← per-run scores (append-only history)

## Run a single eval

    node eval/run-eval.mjs --skill eval/skills/extract-facts-v2.md

Talks to the resident local model (gemma-4-E2B-it @ 127.0.0.1:8080) by
default. Set EVAL_LLM_ENDPOINT / EVAL_LLM_MODEL / EVAL_LLM_TEMPERATURE
to override.

## Rules

- The SCORER, judge.mjs, and ground truth are the exam — never edit them
  to make a score go up. Only the skill file gets improved.
- Tasks are frozen captures. Add NEW tasks when a new failure mode appears;
  never rewrite old ones (that's cheating the exam).
- Current corpus: 6 tasks — 3 honest controls, 3 traps (two-scoop protein,
  container-weight conflation, headline-vs-panel mismatch, fractional
  servings, KG-vs-g distractor).
