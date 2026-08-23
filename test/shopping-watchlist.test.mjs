import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claimDueShoppingWatches, completeShoppingWatchRun, createShoppingWatch, evaluateShoppingWatch, listShoppingWatches, updateShoppingWatch } from "../lib/shopping-watchlist.mjs";

const BASE = Date.parse("2026-08-22T20:00:00.000Z");
const identity = { brand: "Sony", product_line: "WH-1000XM5", model: "WH-1000XM5", color: "black", condition: "new" };
const required = ["brand", "product_line", "model", "color", "condition"];

async function environment(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shopping-watch-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { CHROME_AGENT_BRIDGE_DIR: directory };
}

const createInput = (targets = { target_price_usd: 100 }) => ({ label: "Travel headphones", identity, required_fields: required, targets, sources: ["https://shop.example/item"], settings: { cooldown_hours: 24, realert_drop_usd: 1 } });
const evaluation = (watch_id, price, overrides = {}) => ({
  watch_id,
  candidate_identity: identity,
  current: { variant: "black", condition: "new", currency: "USD", landed_total_usd: price, landed_price_verified: true, stock: "in_stock", risk_status: "low", merchant: "Acme", offer_url: "https://shop.example/item" },
  captured_at: new Date(BASE).toISOString(),
  source: { id: `price-${price}`, source_type: "retailer", url: "https://shop.example/item" },
  ...overrides,
});

test("watch creation is persistent, private, and idempotent", async (context) => {
  const env = await environment(context);
  const first = await createShoppingWatch(createInput(), env, () => BASE);
  const second = await createShoppingWatch(createInput(), env, () => BASE + 1_000);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.watch.id, first.watch.id);
  const listed = await listShoppingWatches({}, env);
  assert.equal(listed.watches.length, 1);
  const stat = await fs.stat(path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-watches.json"));
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
});

test("weak identity and an empty target are rejected", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => createShoppingWatch({ identity: { brand: "Sony" }, required_fields: ["brand"], targets: { target_price_usd: 100 } }, env), { code: "watch_identity_insufficient" });
  await assert.rejects(() => createShoppingWatch({ identity, required_fields: required, targets: {} }, env), { code: "watch_target_required" });
});

test("an exact safe target-price hit alerts but never authorizes purchase", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch(createInput(), env, () => BASE - 1_000);
  const result = await evaluateShoppingWatch(evaluation(created.watch.id, 90), env, () => BASE);
  assert.equal(result.identity.classification, "exact_match");
  assert.equal(result.alert.should_notify, true);
  assert.deepEqual(result.alert.reasons, ["target_price_reached"]);
  assert.equal(result.alert.purchase_allowed, false);
  assert.equal(result.alert.checkout_confirmation_required, true);
  assert.equal(result.watch.observation_count, 1);
});

test("wrong identity and elevated risk cannot alert or pollute history", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch(createInput(), env, () => BASE - 1_000);
  const wrong = await evaluateShoppingWatch(evaluation(created.watch.id, 50, { candidate_identity: { ...identity, model: "WH-1000XM4", product_line: "WH-1000XM4" } }), env, () => BASE);
  assert.equal(wrong.alert.should_notify, false);
  assert.equal(wrong.alert.suppressed_reason, "identity_not_exact");
  assert.equal(wrong.watch.observation_count, 0);
  const risky = await evaluateShoppingWatch(evaluation(created.watch.id, 40, { current: { ...evaluation(created.watch.id, 40).current, risk_status: "elevated" } }), env, () => BASE + 1_000);
  assert.equal(risky.alert.suppressed_reason, "offer_risk_elevated");
  assert.equal(risky.watch.observation_count, 0);
});

test("cooldown suppresses duplicates while a meaningful improvement re-alerts", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch(createInput(), env, () => BASE - 1_000);
  const first = await evaluateShoppingWatch(evaluation(created.watch.id, 90), env, () => BASE);
  const duplicate = await evaluateShoppingWatch(evaluation(created.watch.id, 90), env, () => BASE + 3_600_000);
  const improved = await evaluateShoppingWatch(evaluation(created.watch.id, 88), env, () => BASE + 7_200_000);
  assert.equal(first.alert.should_notify, true);
  assert.equal(duplicate.alert.should_notify, false);
  assert.equal(duplicate.alert.suppressed_reason, "cooldown_duplicate");
  assert.equal(improved.alert.should_notify, true);
});

test("verified observations accumulate until a historical deal threshold becomes actionable", async (context) => {
  const env = await environment(context);
  let clock = BASE - 60 * 86_400_000;
  const created = await createShoppingWatch(createInput({ maximum_deal_quality: "below_typical" }), env, () => clock);
  for (const price of [100, 95, 90, 85, 80]) {
    clock += 10 * 86_400_000;
    const result = await evaluateShoppingWatch(evaluation(created.watch.id, price, { captured_at: new Date(clock).toISOString() }), env, () => clock);
    assert.equal(result.alert.should_notify, false);
  }
  clock += 10 * 86_400_000;
  const low = await evaluateShoppingWatch(evaluation(created.watch.id, 70, { captured_at: new Date(clock).toISOString() }), env, () => clock);
  assert.equal(low.deal.history.sufficient, true);
  assert.equal(low.deal.deal_quality, "historical_low");
  assert.equal(low.alert.should_notify, true);
  assert.deepEqual(low.alert.reasons, ["deal_quality_reached"]);
});

test("revision checks prevent lost updates and archived watches stay recoverable", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch(createInput(), env, () => BASE);
  const paused = await updateShoppingWatch({ watch_id: created.watch.id, expected_revision: 1, status: "paused" }, env, () => BASE + 1_000);
  assert.equal(paused.watch.status, "paused");
  await assert.rejects(() => updateShoppingWatch({ watch_id: created.watch.id, expected_revision: 1, status: "active" }, env), { code: "watch_revision_conflict" });
  const archived = await updateShoppingWatch({ watch_id: created.watch.id, expected_revision: 2, status: "archived" }, env, () => BASE + 2_000);
  assert.equal(archived.watch.status, "archived");
  assert.equal((await listShoppingWatches({}, env)).watches.length, 0);
  assert.equal((await listShoppingWatches({ include_archived: true }, env)).watches.length, 1);
});

test("concurrent creates are serialized without losing distinct watches", async (context) => {
  const env = await environment(context);
  await Promise.all([
    createShoppingWatch(createInput({ target_price_usd: 90 }), env, () => BASE),
    createShoppingWatch(createInput({ target_price_usd: 80 }), env, () => BASE),
  ]);
  const listed = await listShoppingWatches({}, env);
  assert.equal(listed.watches.length, 2);
  assert.equal(listed.state_revision, 2);
});

test("due watches are leased exclusively and become due after successful cadence", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch({ ...createInput(), settings: { cooldown_hours: 24, realert_drop_usd: 1, check_interval_minutes: 60, retry_base_minutes: 10 } }, env, () => BASE);
  const first = await claimDueShoppingWatches({ worker_id: "worker-a", at: new Date(BASE).toISOString(), lease_seconds: 300 }, env);
  const competing = await claimDueShoppingWatches({ worker_id: "worker-b", at: new Date(BASE).toISOString(), lease_seconds: 300 }, env);
  assert.equal(first.runs.length, 1);
  assert.equal(competing.runs.length, 0);
  const completed = await completeShoppingWatchRun({ watch_id: created.watch.id, run_id: first.runs[0].run_id, outcome: "success", completed_at: new Date(BASE + 60_000).toISOString(), evaluated_offers: 2, alert_decisions: 1 }, env);
  assert.equal(completed.next_check_at, new Date(BASE + 61 * 60_000).toISOString());
  assert.equal((await claimDueShoppingWatches({ worker_id: "early", at: new Date(BASE + 30 * 60_000).toISOString() }, env)).runs.length, 0);
  assert.equal((await claimDueShoppingWatches({ worker_id: "due", at: completed.next_check_at }, env)).runs.length, 1);
});

test("expired leases can be reclaimed and stale workers cannot complete them", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch(createInput(), env, () => BASE);
  const old = await claimDueShoppingWatches({ worker_id: "old", at: new Date(BASE).toISOString(), lease_seconds: 30 }, env);
  const replacement = await claimDueShoppingWatches({ worker_id: "new", at: new Date(BASE + 31_000).toISOString(), lease_seconds: 30 }, env);
  assert.equal(replacement.runs.length, 1);
  assert.notEqual(replacement.runs[0].run_id, old.runs[0].run_id);
  await assert.rejects(() => completeShoppingWatchRun({ watch_id: created.watch.id, run_id: old.runs[0].run_id, outcome: "success" }, env), { code: "watch_lease_conflict" });
});

test("failed runs use bounded exponential retry backoff and retain bounded diagnostics", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch({ ...createInput(), settings: { check_interval_minutes: 120, retry_base_minutes: 10 } }, env, () => BASE);
  let at = BASE;
  for (let failure = 1; failure <= 3; failure += 1) {
    const claim = await claimDueShoppingWatches({ worker_id: "retry", at: new Date(at).toISOString() }, env);
    const done = await completeShoppingWatchRun({ watch_id: created.watch.id, run_id: claim.runs[0].run_id, outcome: "failed", error_code: "browser_unavailable", completed_at: new Date(at).toISOString() }, env);
    const expectedDelay = 10 * (2 ** (failure - 1));
    assert.equal(done.next_check_at, new Date(at + expectedDelay * 60_000).toISOString());
    at += expectedDelay * 60_000;
  }
  const listed = await listShoppingWatches({}, env);
  assert.equal(listed.watches[0].run_state.consecutive_failures, 3);
  assert.equal(listed.watches[0].recent_runs.length, 3);
});

test("scheduled evaluation must hold the current watch lease", async (context) => {
  const env = await environment(context);
  const created = await createShoppingWatch(createInput(), env, () => BASE);
  const claim = await claimDueShoppingWatches({ worker_id: "runner", at: new Date(BASE).toISOString() }, env);
  await assert.rejects(() => evaluateShoppingWatch({ ...evaluation(created.watch.id, 85), run_id: "run_wrong" }, env, () => BASE), { code: "watch_lease_conflict" });
  const accepted = await evaluateShoppingWatch({ ...evaluation(created.watch.id, 85), run_id: claim.runs[0].run_id }, env, () => BASE);
  assert.equal(accepted.alert.should_notify, true);
});
