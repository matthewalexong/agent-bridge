# Agent Bridge shopping target: total cost of ownership

This target compares what products cost over the user's real ownership horizon,
not merely their checkout prices.

## Success contract

The harness must:

1. obtain or explicitly state the ownership horizon;
2. use exact-product, provenance-backed acquisition and operating-cost inputs;
3. include selected required accessories, subscriptions, consumables, energy,
   maintenance, repairs, installation, and financing interest or fees;
4. exclude optional services only when the user says they will not use them;
5. preserve verified and estimated low/expected/high ranges;
6. leave missing included costs unbounded instead of treating them as zero;
7. subtract residual value only when it is supported, and otherwise ignore that
   uncertain benefit conservatively;
8. disclose nominal totals, present values, monthly equivalents, assumptions,
   exclusions, and critical unknowns;
9. select a product only when its worst-case supported cost is below every
   competitor's best-case supported cost, unless the user explicitly accepts an
   expected-value decision; and
10. keep all arithmetic and selection outside language models.

## Architecture boundary

The active Hermes or OpenClaw main brain determines which ownership components
apply, gathers evidence, and explains the result. `shopping_ownership_cost` owns
cash-flow expansion, range arithmetic, present value, uncertainty propagation,
and the selection action. Gemma may transcribe a short verified cost table, but
cannot invent components, perform totals, narrow uncertainty, or choose a
product.
