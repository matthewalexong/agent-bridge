# Agent Bridge shopping target: recalls and regulatory safety

This target prevents an unsafe or noncompliant exact product from being
recommended because its price, reviews, or marketing look attractive.

## Success contract

The harness must:

1. require exact product identity and the user's jurisdiction/category;
2. distinguish complete authoritative coverage from an empty or general search;
3. track each required authority, scope, source, search time, and completion;
4. accept official findings only from verified regulator/manufacturer evidence;
5. match exact models and identifiers without contaminating similar products;
6. preserve affected jurisdiction, serial, and manufacture-date ranges;
7. abstain when exact-unit serial/date evidence needed for scope is unavailable;
8. block active applicable recalls, corrective actions, bans, and serious or
   critical safety warnings;
9. clear a recall only with verified exact-unit remediation that explicitly
   restores compliance;
10. never allow remediation to override an active sales or import ban;
11. verify required certification source, exact-model applicability, status,
    and expiry independently from recall coverage;
12. preserve moderate warnings as explicit user tradeoffs;
13. require a current safety artifact in every recommendation dossier;
14. require the complete fresh exact-scope artifact inside offer ranking and
    checkout, matching offer, product, variant, condition, seller, unit scope,
    and destination jurisdiction;
15. invalidate clearance after a jurisdiction, seller, variant, condition,
    serial/date, certification, notice, or remediation change; and
16. never grant purchase authority.

## Architecture boundary

The active Hermes or OpenClaw model identifies authorities, gathers official
evidence, and explains results. Deterministic code owns source eligibility,
coverage freshness/scope, notice matching, range checks, remediation and
certification gates, and dossier precedence. Gemma may transcribe one verified
bounded field but cannot decide coverage, scope, remediation, compliance,
safety action, or product choice.
