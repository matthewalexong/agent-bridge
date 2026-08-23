# Agent Bridge shopping target: canonical product identity

This target prevents lookalikes, adjacent editions, regional variants, bundles,
conditions, and compatible alternatives from entering an exact-product offer
comparison.

## Success contract

The harness must:

1. canonicalize brand, line, model, generation, edition, region, capacity,
   size, color, condition, bundle, MPN, and global trade identifiers;
2. treat stable identifier conflicts as hard identity conflicts;
3. distinguish exact matches from different products, editions, generations,
   variants, conditions, bundles, and compatible alternatives;
4. preserve missing required identity evidence as insufficient rather than
   guessing;
5. bind every resolution to a stable target product ID and offer ID;
6. timestamp the artifact and require matching target product, offer, variant,
   and condition inside offer ranking and checkout;
7. reject missing, stale, mismatched, or non-exact artifacts even when every
   downstream safety and price artifact appears favorable; and
8. rerun identity resolution after any item, model, edition, region, bundle,
   variant, or condition change.

## Architecture boundary

The active Hermes or OpenClaw main brain determines required identity fields,
collects authoritative identifiers, and explains mismatches. Deterministic code
canonicalizes and classifies identity and controls admission to ranking and
checkout. Gemma may normalize a bounded already-verified identifier string but
cannot decide required fields, infer a match, accept a substitute, clear an
identity conflict, or choose an offer.
