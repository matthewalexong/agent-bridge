# Agent Bridge shopping target: unified decision dossier

This target proves that every applicable shopping evaluator covered the same
product and offer with sufficiently fresh evidence before the harness recommends
anything or presents checkout for confirmation.

## Success contract

The harness must:

1. keep product, offer, and checkout phases distinct;
2. require product evidence in every phase;
3. require an explicit reason for every skipped conditional stage;
4. require value, condition, lifecycle, preference, ownership, and deal stages
   when applicable;
5. require identity, merchant, counterfeit, protection, and offer stages for
   offer recommendations;
6. require both a fresh checkout preflight and fresh exact-offer consent artifact
   for checkout review;
7. require a fresh exact-product review-integrity artifact whenever any
   review-derived metric affects ranking, and require review-based ranking to be
   rerun without excluded reviews;
8. require fresh candidate-discovery coverage containing the selected product
   whenever the harness chose among products;
9. require a fresh exact-product comparable-performance artifact whenever a
   measured metric affected ranking;
10. require a fresh scoped value artifact whenever normalized unit value, pack
    economics, yield, or shrinkflation affected ranking;
11. require a fresh exact-offer condition artifact for non-new or condition-
    conflicting inventory;
12. reject missing, stale, future-dated, unidentified, or wrong-subject artifacts;
13. enforce consistent product and offer selections across evaluators;
14. apply hard safety gates before research, clarification, price, or timing;
15. preserve wait/monitor as deferred purchase rather than a failed offer;
16. produce a deterministic dossier identifier and audit; and
17. always keep purchase authority false and require a new explicit checkout
    confirmation after the final summary; and
18. require the complete, fresh, exact-product `product_recommendation` dossier
    that selected the product before any offer can rank or reach checkout; and
19. require a process-issued cryptographic attestation so a model cannot forge
    or mutate product clearance, while retaining a deterministic dossier ID for
    human audit; and
20. require domain-separated process attestations on canonical identity,
    official safety, merchant trust, counterfeit risk, and purchase protection
    before those artifacts can influence offer ranking or checkout; and
21. derive web-page evidence only from short-lived server-registered browser
    snapshots, binding the observed URL, capture time, truncation state, and
    content digest while rejecting model-supplied replacement text; and
22. reconstruct counterfeit evaluator facts from fresh process-attested
    identity plus signed listing, authorized-seller-directory, and warranty
    page artifacts, while leaving unsupported evidence classes unknown instead
    of accepting model-authored verification; and
23. reconstruct merchant roles, recognizable policy presence, cross-page
    consistency, and payment recourse only from fresh signed listing, terms,
    privacy, return-policy, and checkout page artifacts; arbitrary model-labeled
    entities, policies, recourse, complaints, or page kinds cannot create trust;
    and
24. reconstruct exact-offer returns, warranty eligibility and terms,
    repairability, and buyer-protection facts only from fresh signed listing,
    policy, directory, repair, and terms or checkout artifacts, with a mandatory
    known policy inventory and no model-authored protection clearance; and
25. resolve canonical identity only from fresh signed manufacturer-product and
    retailer-listing artifacts, automatically requiring every observed target
    field and explicit listing condition so the model cannot author or weaken
    identity scope; and
26. reconstruct official safety only from fresh signed authority pages whose
    hostnames match a process-owned regulator or certification-body registry,
    binding exact-scope coverage, notices, certifications, remediation,
    canonical identity, and listing seller while rejecting lookalike domains
    and model-authored safety facts; and
27. derive the mandatory regulator set from process-owned jurisdiction and
    product-category policy so the model cannot omit an applicable authority,
    with unsupported or overly broad policy scopes failing closed; and
28. bind the safety product category to fresh signed manufacturer-product
    evidence carried by the canonical identity artifact, rejecting missing,
    tampered, or caller-substituted categories before regulator routing; and
29. surface progressive candidates quickly by running two to four main-brain-
    planned evidence-domain searches concurrently, deduplicating repeated query
    work, narrowing before deep verification, and preserving every hard gate
    before any final recommendation; and
30. capture independent tabs concurrently and reuse signed page extraction
    through a bounded process-owned ledger keyed by exact content and extraction
    scope, while rechecking freshness, isolating page kinds and completeness,
    and preserving per-tab failures as unresolved gaps; and
31. run ready independent deterministic evaluators through a bounded allowlisted
    batch that reuses their original schemas, isolates failures, exposes the
    process-derived dossier requirement matrix, respects dependency waves, and
    always requires separate final dossier composition before recommendation;
    and
32. adapt every evaluator result into an exact-subject, stage-schema-validated,
    process-attested dossier artifact without model transcription, failing on
    ambiguous or mismatched results and rejecting missing, forged, edited,
    wrong-stage, wrong-subject, or restarted-process stages at composition; and
33. bind every evaluator stage and final dossier to one process-attested
    decision context containing the request and profile revisions, objective,
    market, destination, normalized constraints, applicability, phase, product,
    offer, and expiration, and bind each stage to its exact evaluator-input
    digest, so changed requirements or mixed waves cannot replay an otherwise
    valid stage, without adding a separate model round trip; and
34. resolve the exact user-authored panel message by runtime ID into a signed
    immutable receipt, deterministically inventory every clause and likely
    constraint domain, and require exhaustive reciprocal clause-to-constraint
    provenance before signing a decision context, so the main brain cannot
    silently omit a stated budget, deadline, exclusion, compatibility, safety,
    composition, privacy, condition, merchant, fulfillment, or preference; and
35. extract typed money, measurement, percentage, quantity, deadline,
    comparison-operator, unit, currency, and negation literals directly from
    the signed request, requiring exact reciprocal constraint bindings and
    rejecting omitted or altered values, units, directions, dates, or polarity;
    and
36. derive signed process-owned constraint-to-evaluator routes, require every
    batch job to claim its exact complete routed constraint set, enforce exact
    canonical literal projections including strict versus inclusive budget
    operators, attest consumed constraint IDs on every stage, and reject final
    dossiers whose otherwise-valid stages omitted a routed constraint; and
37. require active hard composition, privacy, condition, merchant,
    fulfillment, and explicit safety-certification constraints to carry
    process-allowlisted evaluator bindings grounded in verbatim signed request
    text, then verify their exact values in the deterministic evaluator's real
    requirement fields before execution, rejecting term substitution,
    metadata-only consumption, unsupported mappings, ungrounded polarity, and
    ambiguous relative offer deadlines; and
38. deterministically generate common evaluator bindings from signed request
    clauses for exclusions, privacy controls, allowed condition, merchant
    recourse, tracking and delivery evidence, and named certifications,
    rejecting caller-authored alternatives and exact-set weakening such as
    silently adding an unrequested allowed product condition; and
39. at checkout, require merchant trust to be refreshed from the exact complete
    signed checkout snapshot and bind its snapshot ID, URL, capture time, and
    content digest to final preflight so a replayed or lookalike checkout cannot
    inherit clearance from a different cart page; and
40. bind post-summary confirmation to a short-lived process-attested one-time
    challenge over the exact ready checkout and consent artifacts, resolving
    the response from one new immutable panel message while keeping purchase
    and external-submission authority false; and
41. replace caller-authored recurring-term, selected-add-on, and changed-term
    acceptance flags with a short-lived one-time challenge and immutable-message
    receipt bound to the exact product, offer, terms version, economics,
    cancellation, add-ons, and change inventory; and
42. reconstruct that complete checkout-terms scope only from a fresh complete
    process-attested browser snapshot, requiring explicit terms, add-on, and
    changed-term inventory markers and rejecting model-authored replacements;
    and
43. require a bounded process-owned exact-checkout observation artifact before
    terms acknowledgement or consent, bind it to the latest signed terms
    snapshot, reject out-of-order or cross-origin/product/offer history, retain
    observed countdown resets, unexplained scarcity increases, and removed
    add-ons that reappear, and block undisclosed economic or material term
    changes without treating an observation as a fraud determination; and
44. after purchase, persist a private case only from an immutable explicit
    user request, a fresh signed exact order-receipt artifact, and a matching
    process-attested exact-offer protection policy snapshot, rejecting raw
    verification flags, caller-authored policies, receipt substitutions,
    stale artifacts, and product, offer, seller, condition, date, or total
    mismatches; and
45. require process-attested exact-order browser evidence for consequential
    post-purchase events, including delivery, merchant contact, return shipment,
    refunds, warranty registration, and claim status, so raw or legacy events
    cannot change deadlines or unlock buyer-protection readiness; and
46. reconstruct the sole offer-ranking landed-cost ledger from fresh signed
    listing, checkout, and return-policy pages plus canonical identity, bind it
    to exact source receipts, and require a fresh domain-separated fulfillment
    attestation so caller-authored amounts, verification flags, scope, totals,
    and unsigned promotion output cannot manufacture a price winner; and
47. reconstruct exact applied promotions only from a complete signed checkout
    inventory reconciled with the matching listing and canonical identity,
    require a domain-separated promotion attestation in fulfillment and offer
    ranking, and leave consequential membership or subscription pricing
    unresolved without separate process-attested consent.

## Architecture boundary

The underlying deterministic evaluators own their facts and decisions.
`shopping_decision_dossier` owns cross-stage completeness, applicability,
freshness, scope, precedence, selection consistency, and final readiness. The
active Hermes or OpenClaw model gathers evidence and explains the dossier but
cannot override it. No local model is part of, or required by, the runtime
architecture. If configured, an auxiliary model is only a replaceable stateless
optimization for explicitly delegated mechanical work; removing it cannot
change orchestration, evidence, state, decisions, progress, or results.
