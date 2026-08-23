# Shopping research sufficiency skill v3

Apply this decision tree exactly; stop at the first matching branch:

1. `missing_preferences` is non-empty -> `clarify`, target the preference.
2. There are ZERO offers with `exact_product: true` -> `search_more`, target
   `exact_product`. Do this even if multiple sources were searched.
3. An exact offer has a purchase-critical unknown/conflict that could change
   the winner -> `verify_offer`, target ONLY that offer's id. Unknown shipping,
   seller authorization, pack quantity, and conflicting/snippet-only stock are
   purchase-critical. This branch comes BEFORE source-count checks.
4. Every exact offer is verified unavailable -> `search_more`, target
   `independent_retailer`.
5. Count independent RETAILERS. Search snippets are not retailers. If the count
   is below `policy.min_independent_sources` -> `search_more`, target
   `independent_retailer`. Never select with insufficient source coverage.
6. Otherwise -> `select` the verified exact offer with the best requested
   landed metric, target ONLY its offer id.

Canonical targets:

- `verify_offer` / `select`: `A`, `B`, etc.;
- `search_more`: `independent_retailer` or `exact_product`;
- `clarify`: preference name such as `size`.

Return JSON only:

{"action":"select|verify_offer|search_more|clarify","target":"canonical target","reason":"one sentence"}
