# Agent Bridge shopping target: consent-scoped personal profile

This target enables useful long-term personalization without inferred memory,
silent retention, secret storage, scope leakage, or stale assumptions.

## Success contract

The harness must:

1. remember a field only after an explicit user request;
2. retain ordinary conversational preferences only for the current interaction;
3. require separate consent for sensitive sizes, measurements, accessibility,
   and ingredient-related fields;
4. prohibit credentials, payment-card data, addresses, email, and phone data;
5. store every field with user provenance, decision role, scope, sensitivity,
   revision, consent receipt, and expiry;
6. require separate authorization to view or use sensitive values;
7. resolve only active, unexpired, matching-scope fields;
8. prefer product scope over category scope over global scope;
9. surface equally specific value conflicts instead of guessing;
10. keep hard constraints, preferences, defaults, and assumptions distinct;
11. require current revisions and explicit intent for updates, pauses, resumes,
    and permanent-memory changes;
12. support confirmed, immediate, nonrecoverable field-level forgetting; and
13. keep the private profile file bounded, atomic, and owner-readable only.

## Architecture boundary

The active Hermes or OpenClaw model explains consent, chooses honest scope, and
uses resolved fields. Deterministic profile code owns storage, redaction,
expiry, scope matching, precedence, conflicts, revisions, and deletion. Gemma
may format already-resolved nonsensitive fields but cannot infer or save memory,
handle sensitive values, choose scope, change consent, or delete data.
