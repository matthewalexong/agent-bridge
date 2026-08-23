# Shopping research sufficiency skill v1

Decide whether the shopping research is sufficient. Use only the supplied
state. Choose exactly one action:

- `select`: enough independent retailer coverage exists and the winner's exact
  identity, stock, landed total, and required seller status are verified;
- `verify_offer`: a likely winner exists but a purchase-critical field is
  unknown or conflicting;
- `search_more`: product identity is wrong/absent, all matches are unavailable,
  or fewer independent sources than the policy requires have been checked;
- `clarify`: a missing user preference could change the product or variant.

Never treat unknown shipping as free, a search snippet as verified stock, or a
different edition as the requested product. Return JSON only:

{"action":"select|verify_offer|search_more|clarify","target":"offer id, independent_retailer, exact_product, or missing preference","reason":"one sentence"}
