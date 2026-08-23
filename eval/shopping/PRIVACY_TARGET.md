# Agent Bridge shopping target: connected-product privacy and data security

This target prevents connected-product data practices and security exposure
from being hidden inside generic features, marketing, or preference scores.

## Success contract

The harness must:

1. activate privacy assessment whenever a product ecosystem processes user or
   household data;
2. use only explicit or consent-scoped user privacy requirements;
3. require current exact-product policy sources and a complete data inventory;
4. distinguish required, optional, absent, and unknown collection;
5. evaluate category, purpose, disableability, sharing, sale, targeted ads, and
   retention for every data flow;
6. keep account requirement, cloud requirement, and local core operation
   separate;
7. verify deletion, deletion timing, export, and consent withdrawal separately;
8. verify transport encryption, storage encryption, and MFA independently;
9. evaluate required permissions and their verified core-function necessity;
10. keep factory reset, account unlink, and ownership transfer separate;
11. accept incident findings only from verified authoritative sources scoped to
    the exact product;
12. block hard privacy failures and serious unresolved incidents, while
    preserving moderate incidents as explicit tradeoffs;
13. partition candidates without selecting or authorizing purchase; and
14. require a same-product privacy artifact in the decision dossier whenever
    privacy applies.

## Architecture boundary

The active Hermes or OpenClaw model elicits requirements, collects evidence,
and explains results. Deterministic code owns data-flow checks, control and
security gates, incident authority/scope, abstention, and dossier precedence.
Gemma may transcribe one verified bounded field but cannot infer tolerance,
complete inventories, fill missing facts, assess incidents, or choose.
