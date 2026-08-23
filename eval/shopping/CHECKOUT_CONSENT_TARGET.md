# Agent Bridge shopping target: checkout consent and dark-pattern defense

This target prevents a reconciled cart from disguising continuity charges,
unwanted extras, changed terms, or manipulative urgency.

## Success contract

The harness must:

1. distinguish one-time purchases, subscriptions, trial-to-paid offers,
   memberships, installments, and preorder deposits;
2. verify the first charge plus every recurring amount, cadence, first renewal,
   post-intro price, minimum commitment, and cancellation term that applies;
3. treat incomplete recurring economics or cancellation terms as research;
4. require a short-lived process-attested challenge after the exact recurring
   terms are disclosed, resolving its one-time response from a new immutable
   user-authored panel message while rejecting caller flags, UI state, prior
   messages, and agent inference;
5. remove optional selected add-ons unless the same scope-bound acknowledgement
   receipt freshly accepted that exact selected add-on and terms version;
6. surface forced bundles and cancellation friction for explicit acceptance;
7. block undisclosed changed terms and expire acknowledgement after any material
   change;
8. disregard unverified scarcity, countdown, and social-proof claims without
   allowing urgency to override any gate;
9. require the exact-offer consent artifact alongside checkout preflight in the
   unified dossier;
10. issue a short-lived process-attested one-time challenge bound to the exact
    ready preflight and consent artifacts, then resolve the response from one
    new immutable user-authored panel message;
11. reject altered, expired, prior-message, wrong-response, unknown-process, and
    replayed confirmation challenges; and
12. always keep purchase and external-submission authority false even after a
    valid final confirmation audit receipt.
13. invalidate acknowledgement after any change to product, offer, purchase
    type, terms version, recurring economics, cancellation, selected add-ons,
    or disclosed changed-term inventory.
14. derive those terms and explicit completeness inventories only from a fresh
    complete process-attested checkout snapshot, rejecting caller-authored
    purchase, add-on, change, urgency, text, URL, and verification fields.
15. compare a bounded, capture-ordered history of exact-origin, exact-product,
    exact-offer signed checkout snapshots; retain observed countdown resets,
    scarcity increases without observed restock, and selected add-ons that
    reappear after removal; block undisclosed economic or material term changes;
    bind acknowledgement and consent to the latest signed pattern artifact; and
    describe these as checkout observations rather than fraud findings.

## Model boundary

The active Hermes or OpenClaw model is the main brain for interpreting purchase
type, term changes, cancellation burden, and user intent. No local model is part
of this architecture. If explicitly delegated, Gemma may perform disposable
mechanical formatting outside the trusted evidence and decision path. Gemma
cannot extract or alter signed facts, infer consent, accept an add-on or renewal,
judge urgency, change evaluator status, retain checkout state, or authorize
checkout. Removing Gemma must not change behavior or results.
