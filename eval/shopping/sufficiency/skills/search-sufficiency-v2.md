# Shopping research sufficiency skill v2

Choose the next action by this ordered policy:

1. If a missing user preference could change the product/variant, `clarify` and
   target that preference (for example `size`).
2. Ignore wrong-product and wrong-edition offers as purchase candidates.
3. Before selecting, ask: could resolving an unknown fact change the winner?
   If yes, `verify_offer` for that OFFER ID. This includes:
   - lower headline price but unknown shipping;
   - lower price but required seller authorization is unverified;
   - unknown pack quantity when optimizing unit cost;
   - conflicting or snippet-only stock for the likely offer.
4. If all exact matches are verified out of stock, `search_more` with target
   `independent_retailer`.
5. If no exact product was found, `search_more` with target `exact_product`.
6. If fewer independent retailer sources than `min_independent_sources` were
   checked, `search_more` with target `independent_retailer`.
7. Otherwise, if the cheapest exact offer has verified stock and landed total
   (plus any required seller status), `select` it.

Target vocabulary is strict:

- `verify_offer` or `select` -> target is ONLY the offer id (`A`, `B`, etc.);
- `search_more` -> `independent_retailer` or `exact_product`;
- `clarify` -> the missing preference name.

Return JSON only:

{"action":"select|verify_offer|search_more|clarify","target":"canonical target","reason":"one sentence"}
