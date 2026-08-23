# Agent Bridge shopping target: exact fit and compatibility

This target prevents identity similarity, labels, and incomplete compatibility
tables from being treated as proof that a product will work for the user.

## Success contract

The harness must:

1. keep user requirements separate from candidate evidence;
2. require a concrete source identity for every verified candidate claim;
3. preserve unknown, estimated, conflicting, unsourced, and missing claims as
   research rather than compatibility;
4. compare apparel measurements only against the exact product size chart;
5. never infer or persist sensitive body measurements during assessment;
6. require every declared vehicle/part fitment field and treat incomplete
   coverage as unknown rather than a definitive no-fit result;
7. evaluate voltage, frequency, and plug requirements independently;
8. require all needed connectors, protocols, bands, devices, and regions;
9. convert supported length units and include per-side installation clearance;
10. rotate dimensions only when explicitly permitted;
11. disclose optional mismatches without weakening hard requirements;
12. partition compatible, research, and incompatible candidates without
    selecting a winner or authorizing purchase; and
13. require the compatibility artifact in the decision dossier whenever fit
    affects product usability.

## Architecture boundary

The active Hermes or OpenClaw model elicits the minimum user requirement,
collects authoritative evidence, and explains results. Deterministic code owns
normalization, unit conversion, chart/range/fitment/geometry matching,
abstention, and dossier precedence. Gemma may transcribe one verified bounded
field but cannot infer fit, measurements, mappings, evidence status, or choice.
