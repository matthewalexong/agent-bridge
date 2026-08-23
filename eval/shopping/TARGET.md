# Agent Bridge shopping target 1: the purchasable best match

The first RSI target is deliberately narrower than “ultimate shopping
companion”:

> Given a user's hard constraints and a set of retailer offers, recommend the
> best offer they can actually buy, or explicitly ask/research when the
> evidence is insufficient.

This is the foundation under every later shopping capability. A companion that
finds appealing products but picks the wrong variant, ignores shipping, uses an
ineligible coupon, or recommends an out-of-stock listing is not useful.

## Success contract

The assistant must:

1. preserve exact product and variant identity;
2. reject wrong editions, conditions, quantities, sellers, and stock states;
3. calculate landed price (`price + shipping - eligible coupon`) in
   deterministic code, never in the language model and never from headline
   price alone;
4. optimize either landed total or landed unit cost, as the request specifies;
5. treat an unknown shipping charge as unresolved, not free;
6. choose `research_more` when no verified purchasable match exists;
7. choose `clarify` when the user has not supplied a required preference;
8. cite the critical facts that make the recommendation auditable.

## Architecture boundary

`lib/purchase-controller.mjs` owns the safety-critical decision fields. The
active Hermes or OpenClaw main brain cannot override action, selected offer, or
calculated total. Gemma may normalize bounded already-verified fields but does
not choose or explain the purchase decision. This prevents malformed JSON or
weak auxiliary-model arithmetic from changing what the user buys.

## Gate

- Corpus: `tasks/` (10 adversarial purchase-decision cases).
- Oracle: `lib/purchase-judge.mjs` (deterministic and hidden from the model).
- RSI policy is scored on the active Hermes or OpenClaw main brain. Gemma is
  auxiliary-only for bounded mechanical tasks and smoke checks.
- Primary metric: exact action + exact selected offer.
- Release gate: 100% action agreement and 100% selection agreement on two
  consecutive runs. Evidence-quality score is reported separately.

The next target after this gate is multi-query search sufficiency: deciding
which retailers/pages to inspect and when enough independent evidence has been
collected.
