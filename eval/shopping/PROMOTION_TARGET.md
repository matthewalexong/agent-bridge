# Agent Bridge shopping target: promotion integrity

The shopping harness must compare what the user is guaranteed to pay, not the
largest number shown in a promotion badge.

The target behavior is to:

1. bind promotion evidence to the exact product, offer, capture time, base
   price, shipping amount, and source;
2. require a complete promotion inventory and sourced eligibility, exclusion,
   expiry, stacking, minimum-spend, usage-limit, and obligation terms;
3. permit only a verified discount already applied to the current checkout to
   reduce checkout price;
4. keep rebates, cashback, loyalty points, store credit, bundle credit, and
   trade-in value separate as deferred value;
5. treat gift cards as tender and financing as payment timing, never as price
   reductions;
6. prevent inferred membership, student, military, new-customer, geography,
   app, account, or payment-method eligibility;
7. require a fresh exact-offer user message before accepting a membership,
   subscription, auto-renewal, data-sharing, account, app, trade-in, or other
   consequential obligation;
8. include verified required fees in guaranteed economic cost and disclose
   recurring obligations;
9. reject double counting across embedded prices, cart discounts, credits, and
   deferred value;
10. leave expired, rejected, or ineligible promotions out of price while
    preserving their exclusion reasons;
11. send incomplete or conflicting applied terms to research, consent choices
    to clarification, and impossible discount math to a hard gate;
12. require a fresh exact-offer promotion artifact in offer analysis and the
    unified dossier whenever a promotion affects price, ranking, timing, or
    checkout; and
13. preserve the authority boundary: the evaluator selects nothing,
    `purchase_allowed` is always false, and checkout still needs a fresh user
    confirmation;
14. reconstruct the promotion inventory, exact applied status, amount, expiry,
    stacking, eligibility completeness, and explicit absence of obligations
    only from a fresh complete process-attested exact checkout page plus its
    matching signed listing and canonical identity;
15. reject caller-authored price, shipping, identity, promotion, verification,
    eligibility, completeness, stacking, acceptance, and obligation fields;
16. reconcile the extracted promotion inventory with the signed checkout
    discount and listing/checkout seller, price, offer, and product scope;
17. issue a domain-separated process attestation and require that unchanged
    artifact in fulfillment and offer ranking, rejecting forgery, mutation,
    staleness, truncation, wrong scope, duplicate IDs, and restarted-process
    artifacts; and
18. keep membership and subscription pricing unresolved when a consequential
    obligation would require a separate process-attested consent receipt rather
    than treating an on-page selection or caller flag as acceptance.

Hermes or OpenClaw remains the main brain for interpreting terms, requesting
eligibility facts, deciding applicability, and explaining the deterministic
result. Gemma may transcribe one bounded code, amount, or expiry date from
already-verified text. Gemma cannot infer eligibility, decide stacking,
classify economic value, accept an obligation, clear pricing, select an offer,
or authorize a purchase.
