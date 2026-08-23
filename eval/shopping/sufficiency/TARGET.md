# Shopping target 2: research sufficiency

Given the user request and current research state, choose the next safe action:

- `select` when an exact, purchasable offer has verified critical facts and
  adequate source coverage;
- `verify_offer` when the likely winner has one unresolved purchase-critical
  fact;
- `search_more` when coverage or product identity is insufficient;
- `clarify` when a missing user preference changes what should be bought.

Primary metric: exact action. Secondary metric: exact next target. The corpus
is intentionally state-based. This policy is scored on the main model currently
connected through Hermes/OpenClaw. Local Gemma 4 is auxiliary-only: it may
extract facts, generate fixtures, run cheap smoke checks, or summarize failures,
but its policy score is not the Harness capability score.
