# Agent Bridge shopping target: merchant and marketplace trust

This target resolves the commercial entities behind an offer and evaluates
verifiable identity, policy consistency, payment recourse, return destination,
domain context, and complaint patterns without turning weak signals or
allegations into accusations.

## Success contract

The harness must:

1. distinguish marketplace, displayed seller, legal seller, fulfiller,
   merchant of record, payment processor, and return recipient;
2. never infer seller or merchant identity from fulfillment alone;
3. preserve unknown and conflicting entity evidence;
4. verify terms, privacy, return, checkout, and merchant identity consistency;
5. identify reversible and irreversible payment methods and available dispute
   recourse;
6. verify the return destination and country when it matters to the user;
7. treat domain age, registration, brand mismatch, or email mismatch as weak
   contextual signals that cannot alone prove risk;
8. deduplicate complaints, exclude snippets and unverified reports, distinguish
   resolved from unresolved reports, and require a repeated independent pattern;
9. describe complaints as allegations rather than findings of fraud;
10. gate unknown or elevated merchants before offer comparison;
11. require the complete fresh exact-offer artifact inside deterministic offer
    ranking and checkout, matching offer ID, displayed seller, and—at
    checkout—the merchant of record;
12. invalidate clearance after a seller, storefront, or merchant-of-record
    change and require new role, policy, and payment-recourse verification;
13. bind checkout-phase merchant clearance to the exact complete signed checkout
    snapshot ID, URL, capture time, and content digest used by final preflight,
    requiring a deterministic merchant refresh when that snapshot changes; and
14. never select a product or retailer from merchant trust alone.

## Architecture boundary

The active Hermes or OpenClaw model gathers role and trust evidence and explains
the result. `shopping_merchant_trust` owns role relationships, deterministic
requirements, evidence sufficiency, complaint-pattern thresholds, and purchase
gates. Gemma may transcribe a bounded entity or policy field from verified text,
but cannot infer legal identity, judge complaints, assess trust, or choose an
offer.
