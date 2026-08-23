import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createShoppingCase, listShoppingCases, prepareShoppingCaseAction, updateShoppingCase } from "../lib/shopping-cases.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { createShoppingCaseEvidence } from "../lib/shopping-case-evidence.mjs";
import { issueShoppingRequestReceipt } from "../lib/shopping-request-intent.mjs";
import { assessShoppingProtection } from "../lib/shopping-protection.mjs";
import { createShoppingCaseEventEvidence } from "../lib/shopping-case-event-evidence.mjs";

const BASE = Date.parse("2026-08-22T20:00:00.000Z");
const identity = { brand: "Acme", product_line: "Camera Pro", model: "CP-1", condition: "new" };
const fact = (value) => ({ value, status: "explicit", evidence: [{ excerpt: String(value), start: 0 }] });

function signedEvidence(type, overrides = {}) {
  const pageKind = type === "order_receipt" ? "order_receipt" : type === "merchant_policy" ? "return_policy" : "manufacturer_warranty";
  const marker = pageKind === "order_receipt" ? "order_receipt" : pageKind === "return_policy" ? "return_policy" : "warranty";
  const url = `https://example.test/${pageKind}`;
  const captured_at = overrides.captured_at || "2026-08-22T20:00:00.000Z";
  const receipt = attestShoppingArtifact("browser_snapshot", { source_id: `snapshot-${pageKind}`, snapshot_id: `snapshot-${pageKind}`, tab_id: 1, url, captured_at, content_sha256: (pageKind === "order_receipt" ? "1" : pageKind === "return_policy" ? "2" : "3").repeat(64), truncated: false });
  const orderFacts = { order_number: fact("ORDER-123"), product_id: fact("camera-x"), purchased_at: fact("2026-08-01T12:00:00.000Z"), currency: fact("USD"), item_price_usd: fact(100), shipping_usd: fact(10), total_usd: fact(110) };
  if (overrides.delivered_at !== null) orderFacts.delivered_at = fact(overrides.delivered_at || "2026-08-05T12:00:00.000Z");
  const page = attestShoppingArtifact("page_evidence", {
    source: { url, page_kind: pageKind, captured_at }, extraction_scope: { seller_query: null, directory_complete: false }, source_receipt: receipt,
    facts: { document_markers: { [marker]: fact(true) }, seller: fact("Example Store"), merchant_of_record: fact("Example Store"), order: pageKind === "order_receipt" ? orderFacts : {} },
  });
  return createShoppingCaseEvidence({ page_evidence: page, evaluated_at: captured_at });
}

function signedEvent(type, at, overrides = {}) {
  const kind = overrides.page_kind || (type === "delivered" || type === "return_shipped" ? "carrier_tracking" : type === "warranty_registered" || type.startsWith("claim_") ? "warranty_status" : "merchant_correspondence");
  const url = `https://example.test/${kind}/${type}`;
  const captured_at = overrides.captured_at || "2026-08-22T20:00:00.000Z";
  const sourceId = overrides.source_id || `snapshot-${type}`;
  const receipt = attestShoppingArtifact("browser_snapshot", { source_id: sourceId, snapshot_id: sourceId, tab_id: 1, url, captured_at, content_sha256: (type.charCodeAt(0).toString(16).padStart(2, "0")).repeat(32), truncated: false });
  const page = attestShoppingArtifact("page_evidence", { source: { url, page_kind: kind, captured_at }, extraction_scope: { seller_query: null, directory_complete: false }, source_receipt: receipt, facts: { document_markers: { case_event: fact(true) }, case_event: { type: fact(type), at: fact(at), order_number: fact(overrides.order_number || "ORDER-123"), product_id: fact(overrides.product_id || "camera-x"), reference: fact(overrides.reference || `${type}-ref`), counterparty: fact("Example Store") } } });
  return createShoppingCaseEventEvidence({ page_evidence: page, evaluated_at: captured_at });
}

async function environment(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shopping-cases-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { CHROME_AGENT_BRIDGE_DIR: directory };
}

function protection(overrides = {}) {
  return {
    item_price_usd: 100,
    price_verified: true,
    shipping_usd: 10,
    shipping_verified: true,
    landed_total_usd: 110,
    landed_price_verified: true,
    seller_authorized: true,
    returns: { policy_verified: true, final_sale: false, window_days: 30, window_starts_on: "delivery", opened_items: "accepted", restocking_fee_percent: 0, return_shipping_paid_by: "seller", original_shipping_refundable: true },
    warranty: { policy_verified: true, provider: "manufacturer", duration_months: 12, authorized_seller_required: true, registration_required: true, registration_deadline_days: 14, parts_covered: true, labor_covered: true, deductible_usd: { expected_usd: 0, evidence_status: "verified" }, claim_shipping_paid_by: "provider", estimated_downtime_days_high: 7 },
    repairability: { evidence_verified: true, parts_availability: "widely_available", manual_availability: "official", critical_components_replaceable: true },
    buyer_protection: { window_days: 120 },
    ...overrides,
  };
}

function signedProtection(overrides = {}) {
  return assessShoppingProtection({ evaluated_at: "2026-08-22T20:00:00.000Z", candidates: [{ id: "stored", product_id: "camera-x", condition: "new", seller: "Example Store", ...protection(overrides) }] });
}

function createInput(overrides = {}) {
  return {
    label: "Travel camera",
    merchant: "Example Store",
    seller: "Example Store",
    identity: { ...identity, id: "camera-x" },
    order: { order_number: "ORDER-123", purchased_at: "2026-08-01T12:00:00.000Z", delivered_at: "2026-08-05T12:00:00.000Z", currency: "USD", item_price_usd: 100, shipping_usd: 10, total_usd: 110 },
    offer_id: "stored",
    protection_evidence: signedProtection(),
    evidence: [signedEvidence("order_receipt")],
    request_receipt: issueShoppingRequestReceipt({ request_id: "save-case-request", request_revision: 1, text: "Please track this purchase for returns and warranty claims.", captured_at: "2026-08-22T19:59:00.000Z" }),
    ...overrides,
  };
}

test("case creation is private, persistent, and idempotent", async (context) => {
  const env = await environment(context);
  const first = await createShoppingCase(createInput(), env, () => BASE);
  const second = await createShoppingCase(createInput(), env, () => BASE + 1_000);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.case.id, first.case.id);
  const listed = await listShoppingCases({}, env, () => BASE);
  assert.equal(listed.cases.length, 1);
  assert.equal(listed.cases[0].evidence, undefined);
  const stat = await fs.stat(path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-cases.json"));
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
});

test("deadlines are derived from purchase and delivery dates", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  const deadlines = Object.fromEntries(created.case.timeline.map((item) => [item.type, item]));
  assert.equal(deadlines.return_deadline.at, "2026-09-04T12:00:00.000Z");
  assert.equal(deadlines.warranty_registration_deadline.at, "2026-08-15T12:00:00.000Z");
  assert.equal(deadlines.warranty_registration_deadline.status, "expired");
  assert.equal(deadlines.buyer_protection_deadline.at, "2026-11-29T12:00:00.000Z");
  assert.equal(deadlines.warranty_expiration.at, "2027-08-01T12:00:00.000Z");
});

test("delivery updates recompute delivery-based return deadlines", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput({ order: { ...createInput().order, delivered_at: null }, evidence: [signedEvidence("order_receipt", { delivered_at: null })] }), env, () => BASE);
  assert.equal(created.case.timeline.find((item) => item.type === "return_deadline").status, "unknown");
  const updated = await updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event_evidence: signedEvent("delivered", "2026-08-10T12:00:00.000Z") }, env, () => BASE + 1_000);
  assert.equal(updated.case.timeline.find((item) => item.type === "return_deadline").at, "2026-09-09T12:00:00.000Z");
});

test("due filtering returns cases with an approaching deadline", async (context) => {
  const env = await environment(context);
  await createShoppingCase(createInput(), env, () => BASE);
  const near = await listShoppingCases({ evaluated_at: "2026-08-30T12:00:00.000Z", due_within_days: 7 }, env);
  const far = await listShoppingCases({ evaluated_at: "2026-08-22T12:00:00.000Z", due_within_days: 7 }, env);
  assert.equal(near.cases.length, 1);
  assert.equal(far.cases.length, 0);
});

test("return package requires exact policy evidence and never submits", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  const missing = await prepareShoppingCaseAction({ case_id: created.case.id, action: "return", problem: "Autofocus fails", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.equal(missing.readiness, "needs_evidence");
  assert.deepEqual(missing.missing, ["verified_return_policy"]);
  assert.equal(missing.submission_allowed, false);
  const updated = await updateShoppingCase({ case_id: created.case.id, expected_revision: 1, evidence: [signedEvidence("merchant_policy")] }, env, () => BASE);
  const ready = await prepareShoppingCaseAction({ case_id: updated.case.id, action: "return", problem: "Autofocus fails", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.equal(ready.readiness, "ready_for_user_review");
  assert.equal(ready.draft_only, true);
  assert.equal(ready.requires_new_explicit_confirmation_before_external_submission, true);
});

test("expired and final-sale returns are blocked", async (context) => {
  const env = await environment(context);
  const finalSale = { returns: { ...protection().returns, final_sale: true, window_days: 0, opened_items: "not_accepted" } };
  const created = await createShoppingCase(createInput({ protection_evidence: signedProtection(finalSale), evidence: [...createInput().evidence, signedEvidence("merchant_policy")] }), env, () => BASE);
  const result = await prepareShoppingCaseAction({ case_id: created.case.id, action: "return", problem: "Changed mind", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.equal(result.readiness, "blocked");
  assert.ok(result.blockers.includes("deadline_expired"));
  assert.ok(result.blockers.includes("return_policy_ineligible"));
});

test("warranty package requires a valid warranty, serial, and policy evidence", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  const missing = await prepareShoppingCaseAction({ case_id: created.case.id, action: "warranty_claim", problem: "Will not power on", requested_resolution: "Repair", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.deepEqual(missing.missing.sort(), ["serial_number", "verified_warranty_policy"]);
  const updated = await updateShoppingCase({ case_id: created.case.id, expected_revision: 1, serial_number: "SN-1", evidence: [signedEvidence("manufacturer_policy")] }, env, () => BASE);
  const ready = await prepareShoppingCaseAction({ case_id: updated.case.id, action: "warranty_claim", problem: "Will not power on", requested_resolution: "Repair", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.equal(ready.readiness, "ready_for_user_review");
});

test("invalid warranty eligibility blocks a claim package", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput({ serial_number: "SN-1", protection_evidence: signedProtection({ seller_authorized: false }), evidence: [...createInput().evidence, signedEvidence("manufacturer_policy")] }), env, () => BASE);
  const result = await prepareShoppingCaseAction({ case_id: created.case.id, action: "warranty_claim", problem: "Will not power on", requested_resolution: "Repair", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.equal(result.readiness, "blocked");
  assert.deepEqual(result.blockers, ["warranty_invalid"]);
});

test("buyer protection requires a recorded merchant contact attempt", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  const missing = await prepareShoppingCaseAction({ case_id: created.case.id, action: "buyer_protection", problem: "Item never arrived", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.deepEqual(missing.missing, ["merchant_contact_attempt"]);
  const updated = await updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event_evidence: signedEvent("merchant_contacted", "2026-08-22T19:30:00.000Z") }, env, () => BASE);
  const ready = await prepareShoppingCaseAction({ case_id: updated.case.id, action: "buyer_protection", problem: "Item never arrived", requested_resolution: "Refund", evaluated_at: "2026-08-22T22:00:00.000Z" }, env);
  assert.equal(ready.readiness, "ready_for_user_review");
});

test("optimistic revisions, duplicate evidence, and recoverable archive are enforced", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 2, status: "resolved" }, env, () => BASE), { code: "shopping_case_revision_conflict" });
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 1, evidence: [signedEvidence("order_receipt")] }, env, () => BASE), { code: "shopping_case_evidence_duplicate" });
  const archived = await updateShoppingCase({ case_id: created.case.id, expected_revision: 1, status: "archived" }, env, () => BASE);
  assert.equal(archived.case.status, "archived");
  assert.equal((await listShoppingCases({}, env, () => BASE)).cases.length, 0);
  assert.equal((await listShoppingCases({ include_archived: true }, env, () => BASE)).cases.length, 1);
});

test("weak product identity and invalid dates are rejected", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => createShoppingCase(createInput({ identity: { brand: "Acme" } }), env, () => BASE), { code: "shopping_case_identity_required" });
  await assert.rejects(() => createShoppingCase(createInput({ order: { ...createInput().order, purchased_at: "not-a-date" } }), env, () => BASE), { code: "shopping_case_purchase_date_required" });
});

test("caller-authored verification and receipt-substituted order facts fail closed", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => createShoppingCase(createInput({ evidence: [{ evidence_id: "forged", type: "order_receipt", verified: true }] }), env, () => BASE), { code: "shopping_case_evidence_invalid" });
  for (const order of [
    { ...createInput().order, order_number: "OTHER" },
    { ...createInput().order, total_usd: 1 },
    { ...createInput().order, shipping_usd: 9 },
    { ...createInput().order, delivered_at: "2026-08-06T12:00:00.000Z" },
  ]) {
    await assert.rejects(() => createShoppingCase(createInput({ order }), env, () => BASE), { code: "shopping_case_order_receipt_mismatch" });
  }
  const tampered = signedEvidence("order_receipt");
  tampered.facts.order.total_usd = 1;
  await assert.rejects(() => createShoppingCase(createInput({ evidence: [tampered] }), env, () => BASE), { code: "shopping_case_evidence_invalid" });
});

test("case persistence requires an immutable explicit user request", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => createShoppingCase(createInput({ request_receipt: null }), env), { code: "shopping_case_persistence_intent_invalid" });
  const ordinaryResearch = issueShoppingRequestReceipt({ request_id: "ordinary", request_revision: 1, text: "Find the best camera for me.", captured_at: "2026-08-22T19:59:00.000Z" });
  await assert.rejects(() => createShoppingCase(createInput({ request_receipt: ordinaryResearch }), env), { code: "shopping_case_persistence_intent_required" });
  const tampered = issueShoppingRequestReceipt({ request_id: "tampered", request_revision: 1, text: "Track this order.", captured_at: "2026-08-22T19:59:00.000Z" });
  tampered.text = "Find a camera.";
  await assert.rejects(() => createShoppingCase(createInput({ request_receipt: tampered }), env), { code: "shopping_case_persistence_intent_invalid" });
});

test("forged, edited, stale, and wrong-scope protection evidence cannot seed a case", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => createShoppingCase(createInput({ protection_evidence: { assessments: [] } }), env, () => BASE), { code: "shopping_case_protection_invalid" });
  const tampered = signedProtection();
  tampered.assessments[0].policy_snapshot.returns.window_days = 999;
  await assert.rejects(() => createShoppingCase(createInput({ protection_evidence: tampered }), env, () => BASE), { code: "shopping_case_protection_invalid" });
  await assert.rejects(() => createShoppingCase(createInput({ offer_id: "other" }), env, () => BASE), { code: "shopping_case_protection_scope" });
  const later = BASE + 31 * 86_400_000;
  await assert.rejects(() => createShoppingCase(createInput({ evidence: [signedEvidence("order_receipt", { captured_at: new Date(later).toISOString() })] }), env, () => later), { code: "shopping_case_protection_stale" });
});

test("legacy caller-verified case records migrate conservatively without deletion", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  const target = path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-cases.json");
  const legacy = JSON.parse(await fs.readFile(target, "utf8"));
  legacy.schema_version = 1;
  delete legacy.cases[0].evidence_trust;
  legacy.cases[0].evidence = [{ id: "legacy-receipt", type: "order_receipt", verified: true }];
  legacy.cases[0].events = [{ id: "legacy-contact", type: "merchant_contacted", at: "2026-08-10T12:00:00.000Z" }];
  await fs.writeFile(target, JSON.stringify(legacy));
  const listed = await listShoppingCases({ include_evidence: true }, env, () => BASE);
  assert.equal(listed.cases[0].id, created.case.id);
  assert.equal(listed.cases[0].evidence_trust, "legacy_unattested");
  assert.equal(listed.cases[0].evidence[0].verified, false);
  const action = await prepareShoppingCaseAction({ case_id: created.case.id, action: "return", problem: "Autofocus fails", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.ok(action.missing.includes("verified_order_receipt"));
  assert.ok(action.missing.includes("verified_return_policy"));
  const buyer = await prepareShoppingCaseAction({ case_id: created.case.id, action: "buyer_protection", problem: "Missing item", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" }, env);
  assert.ok(buyer.missing.includes("merchant_contact_attempt"));
});

test("consequential events and delivery changes require signed exact-order evidence", async (context) => {
  const env = await environment(context);
  const created = await createShoppingCase(createInput(), env, () => BASE);
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event: { type: "merchant_contacted", at: "2026-08-22T19:00:00.000Z" } }, env, () => BASE), { code: "shopping_case_event_evidence_required" });
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 1, delivered_at: "2026-08-10T12:00:00.000Z" }, env, () => BASE), { code: "shopping_case_event_evidence_required" });
  const wrongOrder = signedEvent("merchant_contacted", "2026-08-22T19:00:00.000Z", { order_number: "OTHER" });
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event_evidence: wrongOrder }, env, () => BASE), { code: "shopping_case_event_evidence_scope" });
  const tampered = signedEvent("merchant_contacted", "2026-08-22T19:00:00.000Z");
  tampered.type = "refund_received";
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event_evidence: tampered }, env, () => BASE), { code: "shopping_case_event_evidence_invalid" });
  const valid = signedEvent("merchant_contacted", "2026-08-22T19:00:00.000Z");
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event_evidence: valid }, env, () => BASE + 6 * 60_000), { code: "shopping_case_event_evidence_invalid" });
  const updated = await updateShoppingCase({ case_id: created.case.id, expected_revision: 1, event_evidence: valid }, env, () => BASE);
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 2, event_evidence: valid }, env, () => BASE), { code: "shopping_case_event_evidence_duplicate" });
  const recaptured = signedEvent("merchant_contacted", "2026-08-22T19:00:00.000Z", { source_id: "recaptured-merchant-contact" });
  assert.equal(recaptured.event_evidence_id, valid.event_evidence_id);
  assert.notEqual(recaptured.artifact_attestation, valid.artifact_attestation);
  await assert.rejects(() => updateShoppingCase({ case_id: created.case.id, expected_revision: 2, event_evidence: recaptured }, env, () => BASE), { code: "shopping_case_event_evidence_duplicate" });
  const noted = await updateShoppingCase({ case_id: created.case.id, expected_revision: updated.case.revision, note: { text: "Private reminder only" } }, env, () => BASE);
  assert.equal(noted.case.events.at(-1).type, "note");
});
