# Shopping research sufficiency skill v5

Use the precomputed object named `derived_state`. Do not recompute its fields.
Evaluate these exact JSON paths from top to bottom and stop after one branch:

```text
if missing_preferences.length > 0:
  action = clarify; target = missing_preferences[0]
else if derived_state.exact_offer_ids.length == 0:
  action = search_more; target = exact_product
else if derived_state.critical_unknown_offer_ids.length > 0:
  action = verify_offer; target = derived_state.critical_unknown_offer_ids[0]
else if derived_state.all_exact_offers_verified_unavailable == true:
  action = search_more; target = independent_retailer
else if derived_state.source_coverage_sufficient == false:
  action = search_more; target = independent_retailer
else:
  action = select; target = the exact verified offer with the lowest requested metric
```

An offer ID is never a search target unless action is `select` or
`verify_offer`. Return JSON only:

{"action":"select|verify_offer|search_more|clarify","target":"canonical target","reason":"one sentence"}
