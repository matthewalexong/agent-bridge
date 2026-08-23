# Agent Bridge shopping target: exact-offer condition integrity

This target prevents used, open-box, refurbished, renewed, display, and
parts-only inventory from being ranked on seller labels that do not prove the
physical state of the exact unit.

## Success contract

The harness must:

1. bind every assessment to the exact canonical product, offer, inspection, and
   condition version;
2. treat merchant grades as claims governed by a sourced complete grading
   scheme, never as cross-merchant equivalents;
3. require exact-item photos bound to unique used or open-box units and reject
   stock or mixed photos as proof of defects;
4. require a complete verified defect inventory rather than interpreting
   silence as defect-free;
5. require sourced results for every decision-relevant functional test and
   block verified critical failures;
6. normalize renewed and remanufactured to refurbished while separately
   verifying performer, standard, work inventory, wipe status, and replacement
   part provenance;
7. verify battery health and cycle count when required and keep original versus
   replacement battery provenance explicit;
8. independently verify activation, MDM, carrier, finance, and lost/stolen
   status, blocking present controls while preserving unknowns as research and
   permitting only a carrier lock the user explicitly allowed;
9. verify the complete included-accessory inventory and required accessory
   function;
10. separately verify data wiping and sanitation when applicable rather than
    inferring either from a reset, refurbished label, or appearance;
11. treat moderate cosmetic defects, third-party replacement parts, and display
    exposure as explicit tradeoffs;
12. accept tradeoffs only from a fresh current user message scoped to the exact
    offer and current condition version;
13. block a nominally new item when verified opened, activated, or prior-use
    evidence contradicts that condition;
14. require this exact-offer artifact in offer and checkout dossiers whenever
    inventory is non-new or condition evidence conflicts; and
15. never select an offer, authorize checkout, or authorize purchase.

## Architecture boundary

Hermes or OpenClaw remains the main brain for identifying applicable checks,
gathering exact evidence, and explaining tradeoffs. Deterministic code owns
condition normalization, evidence completeness, tests, defect and lock gates,
thresholds, acceptance scope, and dossier precedence. Gemma may normalize one
already-verified grade label, test name, or accessory name. Gemma cannot infer
physical state, exact-item photo scope, test coverage, refurbishment quality,
part provenance, battery health, lock clearance, defect acceptance, action, or
choice.
