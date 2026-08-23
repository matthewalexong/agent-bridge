# Agent Bridge shopping target: lifecycle and ecosystem resilience

This target determines whether a product can remain secure, functional,
serviceable, supplied, interoperable, and portable across the user's ownership
horizon.

## Success contract

The harness must:

1. use exact-product, provenance-backed lifecycle evidence;
2. obtain or explicitly state the ownership/support horizon;
3. distinguish current support from a verified future commitment;
4. allow only verified commitments to satisfy hard security, functional, or
   cloud-support requirements;
5. model cloud/account dependence and the effect of vendor shutdown;
6. inventory required consumables, parts, batteries, accessories, services,
   and apps with availability, alternatives, and supply commitments;
7. block discontinued required inputs without verified alternatives;
8. preserve vendor-only, scarce, or early-ending supply as explicit exposure;
9. verify open standards, offline operation, data export, transferability,
   proprietary dependencies, migration path, and bounded migration cost;
10. keep lifecycle rejection, unknowns, and accepted tradeoffs distinct;
11. partition products without selecting a winner; and
12. pass expected migration cost to ownership analysis at most once.

## Architecture boundary

The active Hermes or OpenClaw main brain identifies applicable dependencies,
gathers evidence, and explains tradeoffs. `shopping_lifecycle_assess` owns date
coverage, requirement enforcement, dependency continuity, exposure categories,
and purchase gates. Gemma may transcribe a bounded verified field but cannot
infer support, continuity, interoperability, shutdown impact, migration, status,
or product choice.
