# Agent Bridge shopping target: post-purchase case management

This target preserves exact purchase and policy evidence, derives protection
deadlines, and prepares returns or claims without silently storing a purchase,
inventing evidence, or taking an external action.

## Success contract

The harness must:

1. create a case only after an explicit user request to save or track it;
2. store cases locally in a private bounded file and never accept payment
   credentials;
3. preserve exact identity, seller, order, receipt, and exact-offer policy
   provenance;
4. derive return, registration, buyer-protection, and warranty deadlines from
   verified purchase/delivery dates and policy terms;
5. distinguish an unknown deadline from an expired deadline;
6. expose due-window filtering without claiming that a recurring reminder is
   active;
7. use optimistic revisions and recoverable archive semantics;
8. prepare return, warranty, and buyer-protection packages only from stored
   facts, reporting missing evidence and eligibility blockers;
9. require a verified receipt and action-specific policy evidence;
10. never contact a seller, file a claim, ship an item, or submit a form from a
    preparation operation; and
11. require a new explicit user confirmation immediately before any later
    external submission.
12. resolve the exact immutable user-authored panel message and persist a case
    only when that message explicitly requests saving, tracking, remembering,
    storing, or managing a purchase, order, receipt, return, warranty, or claim;
13. derive order receipt and policy evidence only from fresh complete signed
    browser page artifacts, rejecting caller-authored verification flags,
    excerpts, URLs, totals, dates, seller identity, and policy records; and
14. require a fresh process-attested exact-offer protection artifact, bind its
    product, offer, seller, condition, and immutable policy snapshot to the
    signed order receipt, and reject edited, stale, restarted-process, or
    scope-mismatched evidence before persistence;
15. derive delivery, merchant contact, return request/shipment/refund, warranty
    registration, and claim-opened/resolved events only from fresh complete
    signed browser pages whose event type is allowed for that page kind and
    whose order number and product match the stored case; and
16. prohibit raw consequential event and delivery-date mutation, deduplicate
    signed event artifacts, reject pre-purchase or future events, and prevent
    legacy caller-authored events from satisfying buyer-protection prerequisites.

## Architecture boundary

The active Hermes or OpenClaw model is the main brain and decides which pages
to obtain and how to explain the case. The deterministic shopping-case tools
own signed extraction, scope reconciliation, persistence, revisions, deadline
status, readiness, and submission gates. No local model is part of this
architecture. Gemma cannot transcribe receipt or policy facts into the trusted
path, determine eligibility, infer missing evidence, prepare strategy, retain
case state, or authorize an external action.
