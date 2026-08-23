# Agent Bridge shopping target: ingredients, allergens, and materials

This target checks explicit composition constraints against the exact offer
formulation without providing medical diagnosis or inventing equivalence.

## Success contract

The harness must:

1. use only explicit or freshly authorized consent-scoped constraints;
2. match the exact formulation ID, region, and label version;
3. require sourced complete ingredient/material/hazard inventories when used;
4. match only exact declared names, subcomponents, and explicit aliases;
5. keep ingredients, materials, allergens, claims, and hazards separate;
6. require verified directly comparable concentration units;
7. distinguish contains, cross-contact forms, free-from, and unknown;
8. apply the user's explicit cross-contact policy;
9. never infer free-from status from omission or incomplete labels;
10. preserve certified, verified, marketing, unverified, and absent claims;
11. hard-block explicit conflicts and abstain on missing scope/evidence;
12. provide no diagnosis, treatment recommendation, product selection, or
    purchase authority; and
13. require a composition artifact in the dossier whenever composition matters.

## Architecture boundary

Hermes or OpenClaw elicits constraints, gathers exact-label evidence, and
explains results. Deterministic code owns exact matching, explicit aliases,
scope, concentration, cross-contact, claim/hazard gates, and dossier precedence.
Gemma may transcribe one verified bounded label field but cannot infer medical,
chemical, allergen, formulation, evidence, action, or choice conclusions.
