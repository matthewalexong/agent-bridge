# Agent Bridge shopping target: fully landed cost and fulfillment reliability

This target prevents an advertised low price from winning when import charges,
customs responsibility, delivery reliability, or return geography are missing.

## Success contract

The harness must:

1. distinguish advertised item-plus-shipping from fully landed acquisition cost;
2. account explicitly for shipping, tax, duty, brokerage, carrier, currency-
   conversion, verified immediate discounts, and required promotion-obligation
   components;
3. treat missing components as unknown, never zero;
4. accept `included` or `not_applicable` only with verified evidence;
5. preserve low, expected, and high totals when any amount is estimated;
6. verify ships-from country, destination eligibility, Incoterm, customs
   responsibility, restrictions, and document completeness;
7. evaluate the full delivery window, tracking, and user-required date;
8. expose return country, return shipping, and import-charge refundability;
9. block prohibited, ineligible, definitely late, over-budget, or disallowed-
   return-country offers regardless of advertised price;
10. request research for unresolved cost or fulfillment facts and clarification
    when bounded cost or delivery uncertainty crosses a user constraint;
11. reject raw fulfillment discounts unless a fresh exact-offer promotion
    artifact proves the immediate discount and its obligations;
12. make the complete fresh fulfillment artifact the sole acquisition-cost
    source for offer ranking, never item price plus shipping;
13. select from estimated ranges only under robust worst-case dominance, or
    after explicit expected-value authorization; require exact cost for unit-
    value ranking;
14. require the selected fulfillment and offer artifacts to carry identical
    landed-cost ranges in every offer and checkout dossier; and
15. never grant purchase authority;
16. reconstruct exact-offer price, charge, route, delivery, and return facts
    only from fresh complete process-attested listing, checkout, and policy
    pages plus the fresh canonical identity artifact, rejecting caller-authored
    amounts, evidence status, exact-identity, destination, and customs fields;
17. bind the resulting ledger to its source receipts and issue a domain-
    separated process attestation that offer ranking verifies for integrity,
    freshness, destination, product, and offer scope; and
18. reject forged, edited, stale, truncated, wrong-seller, wrong-product,
    wrong-offer, wrong-destination, conflicting component/total, and unsigned
    promotion inputs rather than laundering them through a signed ledger.

## Architecture boundary

The active Hermes or OpenClaw model gathers provenance-backed route and policy
facts and explains the deterministic assessment. Deterministic code owns charge
completeness, range arithmetic, customs/delivery/return gates, and dossier
precedence. Gemma may transcribe a single verified bounded field but cannot
infer zero costs, interpret Incoterms, estimate duties, classify promotions,
accept uncertainty, choose expected-value ranking, or choose an offer.
