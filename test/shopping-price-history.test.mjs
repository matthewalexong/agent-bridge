import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { createShoppingPriceHistoryLedger } from "../lib/shopping-price-history.mjs";

const BASE = Date.parse("2026-06-01T12:00:00.000Z");
const CONTEXT = "shopping_context_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRODUCT = "camera-x";
const OFFER = "offer-a";

async function environment(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shopping-price-history-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { CHROME_AGENT_BRIDGE_DIR: directory };
}

function signedStage(name, at, fields) {
  return attestShoppingArtifact("dossier_stage", {
    artifact_id: `${name}-${Date.parse(at)}`,
    decision_context_id: CONTEXT,
    evaluator_input_sha256: "a".repeat(64),
    consumed_constraint_ids: [],
    stage: name,
    evaluated_at: at,
    ...fields,
  });
}

function eligibleEvidence(at, price, overrides = {}) {
  const listing = attestShoppingArtifact("page_evidence", {
    source: { url: "https://shop.example/products/camera-x?session=private#offer", page_kind: "retailer_listing", captured_at: at },
    facts: { identity: { condition: { value: "new", status: "explicit", evidence: [] }, color: { value: "black", status: "explicit", evidence: [] } } },
  });
  const candidate_offers = attestShoppingArtifact("candidate_offers", { candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", evaluated_at: at, offers: [{ candidate_id: OFFER, listing_evidence: listing }] });
  const common = { product_id: PRODUCT, offer_id: OFFER };
  const stages = {
    identity: signedStage("identity", at, { ...common, classification: "exact_match", safe_to_compare_offers: true }),
    merchant: signedStage("merchant", at, { ...common, purchase_gate: "eligible_for_other_shopping_checks" }),
    counterfeit: signedStage("counterfeit", at, { ...common, risk_status: "low", authorization_requirement_status: "satisfied", purchase_gate: "eligible_for_other_shopping_checks", evidence_links: [] }),
    protection: signedStage("protection", at, { ...common, status: "eligible", return_window_days: 30, warranty_duration_months: 12, buyer_protection_days: 60, evidence_links: [] }),
    fulfillment: signedStage("fulfillment", at, { ...common, action: "eligible", fully_landed_total_usd: { low_usd: price, expected_usd: price, high_usd: price }, fully_landed_status: "verified", safe_for_offer_comparison: true, delivery_earliest_at: null, delivery_latest_at: null, tracking_available: null, cost_breakdown: [], evidence_links: [] }),
    offer: signedStage("offer", at, { ...common, action: "select", selected_offer: OFFER, reason: "safe exact offer", landed_total_usd: price, landed_total_range_usd: { low_usd: price, expected_usd: price, high_usd: price }, landed_price_verified: true, promotion_affects_price: false, stock: "in_stock" }),
    deal: signedStage("deal", at, { ...common, current_variant: null, current_condition: "new", current_currency: "USD", current_landed_total_usd: price, current_landed_price_verified: true, current_exact_identity: true, current_stock: "in_stock", current_risk_status: "low", timing_action: "research_more", timing_reason: "too_few_comparable_observations", deal_quality: "insufficient_evidence", history_provenance: "caller_supplied", history_sufficient: false, history_observation_count: 0, history_span_days: 0, history_median_usd: null, current_vs_median_percent: null, sale_claim_flags: [] }),
  };
  for (const [name, patch] of Object.entries(overrides.stages || {})) stages[name] = signedStage(name, at, { ...stages[name], artifact_attestation: undefined, ...patch });
  return {
    dossier: {
      dossier_id: `dossier-${Date.parse(at)}`,
      decision_context_id: CONTEXT,
      phase: "offer_recommendation",
      product_id: PRODUCT,
      offer_id: OFFER,
      decision: { action: "research_more", blockers: [], research: ["deal:research_more"], clarifications: [], warnings: [], purchase_allowed: false, model_override_allowed: false },
      ...overrides.dossier,
    },
    stages,
    candidate_offers,
  };
}

function current(price, evaluatedAt) {
  return {
    current: { offer_id: OFFER, product_key: PRODUCT, condition: "new", currency: "USD", landed_total_usd: price, landed_price_verified: true, exact_identity: true, stock: "in_stock", risk_status: "low" },
    observations: [{ product_key: PRODUCT, condition: "new", currency: "USD", landed_total_usd: 10, verified: true, observed_at: new Date(evaluatedAt - 60 * 86_400_000).toISOString(), source: { id: "caller", source_type: "history_provider", url: "https://caller.example/history" } }],
    policy: { evaluated_at: new Date(evaluatedAt).toISOString(), min_observations: 5, min_distinct_days: 5, min_span_days: 30 },
  };
}

test("signed safe landed observations persist and become process-verified deal history", async (context) => {
  const env = await environment(context);
  let now = BASE;
  const ledger = createShoppingPriceHistoryLedger({ env, clock: () => now });
  for (const [index, price] of [100, 95, 90, 85, 80].entries()) {
    now = BASE + index * 10 * 86_400_000;
    assert.equal((await ledger.record(eligibleEvidence(new Date(now).toISOString(), price))).recorded, true);
  }
  const restarted = createShoppingPriceHistoryLedger({ env, clock: () => now + 10 * 86_400_000 });
  const result = await restarted.evaluate(current(70, now + 10 * 86_400_000));
  assert.equal(result.history_provenance, "process_verified");
  assert.equal(result.history.sufficient, true);
  assert.equal(result.history.stats.observation_count, 5);
  assert.equal(result.history.stats.median_usd, 90);
  assert.equal(result.deal_quality, "historical_low");
  assert.equal(result.timing.action, "buy_now");
  assert.equal(result.history.stats.minimum_usd, 80, "caller-authored $10 history was not merged into verified history");
  const withoutCallerHistory = await restarted.evaluate({ ...current(70, now + 10 * 86_400_000), observations: [] });
  assert.equal(withoutCallerHistory.history_provenance, "process_verified");
  assert.equal((await restarted.inspect()).observations[0].source.url, "https://shop.example/products/camera-x");
  const stat = await fs.stat(path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-price-history.json"));
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
});

test("insufficient process history falls back to caller analysis without verified provenance", async (context) => {
  const env = await environment(context);
  const ledger = createShoppingPriceHistoryLedger({ env, clock: () => BASE });
  await ledger.record(eligibleEvidence(new Date(BASE).toISOString(), 100));
  const result = await ledger.evaluate(current(70, BASE + 40 * 86_400_000));
  assert.equal(result.history_provenance, "caller_supplied");
  assert.equal(result.history.sufficient, false);
});

test("duplicate dossiers are idempotent and storage stays bounded per exact scope", async (context) => {
  const env = await environment(context);
  let now = BASE;
  const ledger = createShoppingPriceHistoryLedger({ env, clock: () => now, max_per_scope: 2 });
  const first = eligibleEvidence(new Date(now).toISOString(), 100);
  assert.equal((await ledger.record(first)).recorded, true);
  assert.equal((await ledger.record(first)).reason, "duplicate");
  for (const price of [90, 80]) {
    now += 86_400_000;
    await ledger.record(eligibleEvidence(new Date(now).toISOString(), price));
  }
  const state = await ledger.inspect();
  assert.equal(state.observations.length, 2);
  assert.deepEqual(state.observations.map((item) => item.landed_total_usd), [90, 80]);
});

test("unsafe, mismatched, estimated, and tampered evidence never pollutes history", async (context) => {
  const env = await environment(context);
  const ledger = createShoppingPriceHistoryLedger({ env, clock: () => BASE });
  const cases = [
    eligibleEvidence(new Date(BASE).toISOString(), 100, { stages: { counterfeit: { risk_status: "elevated", purchase_gate: "avoid_offer" } } }),
    eligibleEvidence(new Date(BASE).toISOString(), 100, { stages: { fulfillment: { fully_landed_status: "estimated" } } }),
    eligibleEvidence(new Date(BASE).toISOString(), 100, { stages: { deal: { current_condition: "used" } } }),
  ];
  const tampered = eligibleEvidence(new Date(BASE).toISOString(), 100);
  tampered.stages.offer.landed_total_usd = 1;
  cases.push(tampered);
  for (const item of cases) assert.deepEqual(await ledger.record(item), { recorded: false, reason: "evidence_not_eligible" });
  assert.equal((await ledger.inspect()).observations.length, 0);
});

test("invalid or symlinked history storage is rejected and cannot manufacture verification", async (context) => {
  const env = await environment(context);
  await fs.mkdir(env.CHROME_AGENT_BRIDGE_DIR, { recursive: true });
  const target = path.join(env.CHROME_AGENT_BRIDGE_DIR, "outside.json");
  const history = path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-price-history.json");
  await fs.writeFile(target, JSON.stringify({ schema_version: 1, revision: 0, observations: [] }));
  await fs.symlink(target, history);
  const ledger = createShoppingPriceHistoryLedger({ env, clock: () => BASE });
  await assert.rejects(() => ledger.evaluate(current(70, BASE)), { code: "shopping_price_history_invalid" });
});
