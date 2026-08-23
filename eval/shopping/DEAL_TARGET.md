# Agent Bridge shopping target: deal quality and purchase timing

This target answers whether a current exact-product offer is historically good
and whether the user should buy, monitor, wait, research, or avoid it.

## Success contract

The harness must:

1. compare landed price, never headline item price, with history;
2. admit only verified observations for the same canonical product, variant,
   condition, and currency;
3. exclude snippets, duplicate observations, invalid dates, and incompatible
   history with explicit reasons;
4. require enough distinct observations across a meaningful time span;
5. use robust distribution statistics rather than MSRP alone;
6. identify incorrect discount arithmetic and inflated reference-price risk;
7. let identity, availability, budget, and seller-risk blockers override an
   attractive historical price;
8. incorporate the user's urgency, target, and maximum price; and
9. never promise that a future price drop will occur.

## Architecture boundary

Hermes or OpenClaw obtains fresh exact-product offer evidence and historical
observations. `shopping_deal_quality` owns comparability filtering, statistics,
sale-claim flags, deal classification, and timing action. Gemma may transcribe a
bounded price-history table, but it cannot classify the deal, select the timing
action, or override safety blockers.
