# Agent Bridge shopping target: comparable unit value and shrinkflation

This target prevents deceptive package counts, incompatible units, unverifiable
yield claims, and raw listing quantity from manufacturing a value winner.

## Success contract

The harness must:

1. define a typed comparison basis before computing unit value;
2. keep count, mass, volume, length, area, duration, servings, uses, loads, and
   doses distinct;
3. use only explicit deterministic unit conversions within one dimension;
4. require verified exact-product identity, landed total, pack count, and net
   quantity for every offer;
5. compute multi-pack basis as verified pack count times verified per-pack net
   quantity, never from raw listing `quantity`;
6. require a sourced protocol and complete identical material conditions for
   usable-yield comparison;
7. refuse serving/dose, mass/volume, density, concentration, coverage, or yield
   substitutions that lack explicit comparable evidence;
8. require verified functional or quality equivalence for cross-product value
   ranking;
9. bind prior packages to the same canonical product and variant before
   reporting package reduction or unit-cost increase;
10. describe scoped package reduction plus unit-cost increase as a shrinkflation
    signal, never fraud or proof of intent;
11. require a cleared exact-offer value artifact for `unit_cost` offer analysis
    and a fresh dossier artifact whenever value affected ranking; and
12. never select a product, authorize checkout, or authorize purchase.

## Architecture boundary

Hermes or OpenClaw remains the main brain for choosing the honest comparison
basis, gathering evidence, and explaining results. Deterministic code owns unit
compatibility, conversion, pack multiplication, protocol/condition equality,
freshness, shrinkflation arithmetic, clearance, and the offer-analysis gate.
Gemma may normalize an already-verified unit label or pack count. Gemma cannot
infer density, yield, serving equivalence, quality equivalence, protocol
comparability, shrinkflation scope, value clearance, or a winner.
