# Agent Bridge shopping target: preference-aware product choice

This target covers choosing among different products after search, rather than
choosing among retailer offers for one already-known product.

## Success contract

The harness must:

1. keep hard constraints separate from preferences;
2. reject a product that violates any known hard constraint;
3. treat an unknown hard-constraint fact as unresolved, not satisfied;
4. use only explicit user preferences and weights for multi-criteria ranking;
5. represent missing preference evidence with lower and upper score bounds;
6. research missing facts when they could change the winner;
7. avoid unnecessary research when a candidate cannot beat the robust winner;
8. ask for clarification when multiple fully evidenced candidates remain tied
   or when the user supplied no preference that distinguishes them; and
9. keep deterministic action and selection fields outside all language models.
10. accept only attributes marked verified by the product-evidence aggregator;
11. keep review sentiment metrics separate from objective specifications; and
12. reject snippets, stale evidence, same-source duplication, and unresolved
    source conflicts as support for a recommendation.
13. accept only candidate IDs cleared by the bounded candidate-discovery
    coverage evaluator.
14. allow empirical preferences and constraints to require a separately
    cleared measured-performance evidence role rather than a declared spec.

## Architecture boundary

The active Hermes or OpenClaw model interprets the conversation, searches,
extracts candidate claims with provenance, and explains the result.
`shopping_product_evidence` owns corroboration, freshness, source independence,
conflict detection, and review-theme aggregation. `shopping_preference_rank`
owns constraint evaluation, weighted scoring, uncertainty bounds, action, and
selected candidate. Gemma may help with bounded low-risk extraction or wording,
but cannot verify evidence, select the product, or override either deterministic
result.

After a product is selected, `shopping_identity_resolve` gates exact listings,
`shopping_risk_features` assesses offer risk, and `shopping_offer_analyze`
selects the purchasable retailer offer.
