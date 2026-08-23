# Shopping watch orchestration

Agent Bridge now provides the state machine needed by a recurring Hermes or
OpenClaw worker, but does not silently install a scheduler.

## Required worker sequence

```text
shopping_watch_claim_due
  -> browser evidence for configured sources
  -> shopping_page_evidence
  -> shopping_identity_resolve
  -> shopping_risk_features
  -> shopping_offer_analyze
  -> shopping_watch_evaluate(run_id)
  -> shopping_watch_complete_run
```

The worker must complete every claimed run. Successful runs advance by the
watch's `check_interval_minutes`; failed runs retry with bounded exponential
backoff starting at `retry_base_minutes`. Leases prevent concurrent workers
from checking the same watch and can be reclaimed after expiry.

The canonical runner prompt is
[`eval/shopping/WATCH_RUNNER.md`](../eval/shopping/WATCH_RUNNER.md).

## Hermes scheduler

The installed Hermes scheduler supports recurring agents with `hermes cron
create`. Before installing a job, the user must choose:

- cadence, such as every six hours;
- delivery destination, such as local, Telegram, Discord, or Signal;
- whether the job follows the current main model or pins a user-selected main
  model; and
- the acceptable browser-research batch size.

Do not pin Gemma as the cron agent. Gemma is auxiliary-only for bounded cheap
tasks and cannot own evidence, alert, or purchase decisions.

After installation, verify with `hermes cron status`, `hermes cron list`, and a
manual `hermes cron run` followed by `hermes cron runs`. A job is active only
when those commands show the configured scheduler and a successful execution.

No scheduler was installed as part of the implementation because cadence and
delivery destination are user-owned external effects.
