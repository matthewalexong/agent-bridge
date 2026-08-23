# Shopping research sufficiency skill v4

The controller supplies `derived_state`; treat it as authoritative. Apply the
first matching branch:

1. `missing_preferences` non-empty -> `clarify`, target the preference.
2. `exact_offer_ids` empty -> `search_more`, target `exact_product`.
3. `critical_unknown_offer_ids` non-empty -> `verify_offer`, target the offer
   ID in that list whose unresolved fact could change the winner. For one ID,
   always target that ID.
4. `all_exact_offers_verified_unavailable` true -> `search_more`, target
   `independent_retailer`.
5. `source_coverage_sufficient` false -> `search_more`, target
   `independent_retailer`. Never select before this gate passes.
6. Otherwise -> `select` the exact, verified offer with the best requested
   landed metric, targeting only its offer ID.

Canonical targets are offer IDs, `independent_retailer`, `exact_product`, or a
missing preference name. Return JSON only:

{"action":"select|verify_offer|search_more|clarify","target":"canonical target","reason":"one sentence"}
