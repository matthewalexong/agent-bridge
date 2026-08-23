# Agent Bridge shopping target: persistent watchlists and alerts

This target stores an exact canonical product and evaluates fresh offers against
the user's explicit price or deal threshold over time.

## Success contract

The harness must:

1. create a watch only after an explicit user request;
2. require a stable canonical identity and at least one explicit threshold;
3. make identical create requests idempotent;
4. store state privately with atomic, locked, revisioned updates;
5. accept observations only when identity, landed price, stock, and seller risk
   pass deterministic gates;
6. retain a bounded price history and exclude unsafe observations from it;
7. suppress duplicate notifications during cooldown while allowing meaningful
   price improvements to re-alert;
8. archive watches recoverably instead of destructively deleting them;
9. distinguish stored configuration from an actually running scheduler; and
10. make every alert informational, with `purchase_allowed: false` and fresh
    checkout confirmation still required.
11. lease due watches atomically so concurrent schedulers cannot duplicate work;
12. reclaim expired leases while rejecting stale-worker completion;
13. record bounded run outcomes and schedule normal cadence or exponential
    retry; and
14. require the active Hermes/OpenClaw main brain—not Gemma—to own recurring
    browser research and alert decisions.

## Architecture boundary

Hermes or OpenClaw owns recurring orchestration: listing active watches,
opening configured sources, gathering fresh evidence, and passing observations
to `shopping_watch_evaluate`. Agent Bridge owns private state, canonical matching,
history, target evaluation, cooldown, and notification decisions. Creating a
watch does not itself create a cron job. Gemma may transcribe bounded page facts,
but cannot create or modify watches, approve observations, decide alerts, or
send notifications.
