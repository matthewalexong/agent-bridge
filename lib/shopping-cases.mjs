import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writePrivateJsonAtomic } from "./auth-token.mjs";
import { bridgeDirectory } from "./config.mjs";
import { canonicalizeProductIdentity } from "./shopping-identity.mjs";
import { assessShoppingProtection } from "./shopping-protection.mjs";
import { validateShoppingCaseEvidence } from "./shopping-case-evidence.mjs";
import { verifyShoppingRequestReceipt } from "./shopping-request-intent.mjs";
import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { validateShoppingCaseEventEvidence } from "./shopping-case-event-evidence.mjs";

const SCHEMA_VERSION = 2;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_CASES = 1_000;
const MAX_EVIDENCE = 100;
const MAX_EVENTS = 200;

const clean = (value, limit = 2_000) => String(value ?? "").trim().slice(0, limit);
const nowIso = (clock) => new Date(clock()).toISOString();
const validDate = (value) => value != null && Number.isFinite(Date.parse(value));

function caseFile(env) {
  return path.join(bridgeDirectory(env), "shopping-cases.json");
}

function emptyState() {
  return { schema_version: SCHEMA_VERSION, revision: 0, cases: [] };
}

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function migrateState(state) {
  if (state?.schema_version !== 1) return state;
  return {
    ...state,
    schema_version: SCHEMA_VERSION,
    cases: (state.cases || []).map((item) => ({
      ...item,
      evidence_trust: "legacy_unattested",
      evidence: (item.evidence || []).map((entry) => ({ ...entry, verified: false, legacy_unattested: true })),
      events: (item.events || []).map((entry) => ({ ...entry, evidence_trust: "legacy_unattested" })),
      protection_candidate: {
        ...(item.protection_candidate || {}), price_verified: false, shipping_verified: false, landed_price_verified: false, seller_authorized: null,
        returns: { ...(item.protection_candidate?.returns || {}), policy_verified: false },
        warranty: { ...(item.protection_candidate?.warranty || {}), policy_verified: false },
        repairability: { ...(item.protection_candidate?.repairability || {}), evidence_verified: false },
      },
    })),
  };
}

function validateState(input) {
  const state = migrateState(input);
  if (state?.schema_version !== SCHEMA_VERSION || !Number.isInteger(state?.revision) || !Array.isArray(state?.cases)) {
    fail("Shopping case file is invalid", "shopping_cases_invalid");
  }
  return state;
}

async function prepareDirectory(env) {
  const directory = bridgeDirectory(env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

async function readState(env) {
  const target = caseFile(env);
  let stat;
  try { stat = await fs.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    fail("Shopping case path is not a safe bounded regular file", "shopping_cases_invalid");
  }
  if (process.platform !== "win32") await fs.chmod(target, 0o600);
  return validateState(JSON.parse(await fs.readFile(target, "utf8")));
}

async function withLock(env, callback) {
  const directory = await prepareDirectory(env);
  const lockPath = path.join(directory, "shopping-cases.lock");
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try { handle = await fs.open(lockPath, "wx", 0o600); } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) fail("Could not acquire the shopping case update lock", "shopping_cases_lock_failed");
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    const state = await readState(env);
    const result = await callback(state);
    if (result.write !== false) {
      state.revision += 1;
      await writePrivateJsonAtomic(caseFile(env), state);
    }
    return result.value;
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function normalizeEvidence(evidence = [], evaluatedAt = null, maxAgeSeconds = 300) {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) fail("Evidence exceeds the bounded case limit", "shopping_case_evidence_invalid");
  return evidence.map((item) => {
    if (!validateShoppingCaseEvidence(item, evaluatedAt, maxAgeSeconds)) fail("Case evidence must be a fresh complete process-attested page-derived artifact", "shopping_case_evidence_invalid");
    return {
    id: clean(item.evidence_id, 160),
    type: item.type,
    verified: true,
    source_url: item.source_url || null,
    captured_at: item.captured_at || null,
    excerpt: clean(item.excerpt),
    artifact_attestation: item.artifact_attestation,
    facts: item.facts || {},
  }; });
}

function same(left, right) { return clean(left, 500).toLowerCase() === clean(right, 500).toLowerCase(); }

function validateOrderReceipt(input, order, evidence) {
  const receipt = evidence.find((item) => item.type === "order_receipt" && item.verified);
  if (!receipt) fail("A signed exact order receipt is required", "shopping_case_order_receipt_required");
  const facts = receipt.facts || {};
  const observed = facts.order || {};
  if (!same(observed.order_number, order.order_number) || !same(observed.product_id, input.identity?.id || input.identity?.product_id || input.protection_candidate?.product_id)
    || Date.parse(observed.purchased_at || "") !== Date.parse(order.purchased_at)
    || (observed.delivered_at ? Date.parse(observed.delivered_at) : null) !== (order.delivered_at ? Date.parse(order.delivered_at) : null)
    || !same(observed.currency, order.currency)
    || observed.item_price_usd !== order.item_price_usd
    || observed.shipping_usd !== order.shipping_usd
    || observed.total_usd !== order.total_usd
    || (facts.seller && input.seller && !same(facts.seller, input.seller))
    || (facts.merchant_of_record && !same(facts.merchant_of_record, input.merchant))) {
    fail("Order input does not match the signed exact receipt", "shopping_case_order_receipt_mismatch");
  }
}

function validatePersistenceIntent(receipt) {
  if (!verifyShoppingRequestReceipt(receipt)) fail("A process-attested user request is required to persist a shopping case", "shopping_case_persistence_intent_invalid");
  const text = clean(receipt.text, 20_000);
  const action = /\b(?:save|track|remember|store|manage|keep\s+(?:a\s+)?record\s+of|create\s+(?:a\s+)?case\s+for)\b/i.test(text);
  const subject = /\b(?:purchase|order|receipt|return|warranty|claim|shopping\s+case)\b/i.test(text);
  if (!action || !subject) fail("The user message does not explicitly request persistent purchase tracking", "shopping_case_persistence_intent_required");
  return receipt;
}

function protectionCandidateFromArtifact(input, evaluatedAt) {
  const artifact = input.protection_evidence;
  if (!verifyShoppingArtifactAttestation("protection", artifact)) fail("A process-attested protection artifact is required", "shopping_case_protection_invalid");
  const artifactAt = Date.parse(artifact.evaluated_at || "");
  const maxAge = (input.max_protection_age_seconds ?? 2_592_000) * 1_000;
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxAge) fail("Protection evidence is stale or future-dated", "shopping_case_protection_stale");
  const assessment = artifact.assessments?.find((item) => same(item.id, input.offer_id));
  const productId = input.identity?.id || input.identity?.product_id;
  if (!assessment || !assessment.policy_snapshot || !same(assessment.product_id, productId) || !same(assessment.seller, input.seller) || !same(assessment.condition, input.identity?.condition || "new")) {
    fail("Protection evidence does not match the exact purchased offer", "shopping_case_protection_scope");
  }
  const policy = assessment.policy_snapshot;
  return { id: assessment.id, product_id: assessment.product_id, variant: assessment.variant, condition: assessment.condition, seller: assessment.seller, ...structuredClone(policy) };
}

function normalizeOrder(order = {}) {
  if (!validDate(order.purchased_at)) fail("A valid purchase timestamp is required", "shopping_case_purchase_date_required");
  if (order.delivered_at != null && !validDate(order.delivered_at)) fail("Delivery timestamp is invalid", "shopping_case_delivery_date_invalid");
  return {
    order_number: clean(order.order_number, 300) || null,
    purchased_at: new Date(order.purchased_at).toISOString(),
    delivered_at: order.delivered_at ? new Date(order.delivered_at).toISOString() : null,
    currency: clean(order.currency || "USD", 3).toUpperCase(),
    item_price_usd: order.item_price_usd ?? null,
    shipping_usd: order.shipping_usd ?? null,
    total_usd: order.total_usd ?? null,
  };
}

function candidateFor(shoppingCase) {
  const candidate = shoppingCase.protection_candidate;
  return {
    ...candidate,
    id: shoppingCase.id,
    item_price_usd: shoppingCase.order.item_price_usd ?? candidate.item_price_usd,
    shipping_usd: shoppingCase.order.shipping_usd ?? candidate.shipping_usd,
    landed_total_usd: shoppingCase.order.total_usd ?? candidate.landed_total_usd,
    purchase_date: shoppingCase.order.purchased_at,
    delivered_at: shoppingCase.order.delivered_at,
  };
}

function protectionFor(shoppingCase) {
  return assessShoppingProtection({ candidates: [candidateFor(shoppingCase)] }).assessments[0];
}

function deadlineStatus(at, evaluatedAt) {
  if (!at || !validDate(at)) return "unknown";
  const delta = Date.parse(at) - Date.parse(evaluatedAt);
  if (delta < 0) return "expired";
  if (delta < 86_400_000) return "due_today";
  if (delta <= 7 * 86_400_000) return "due_within_7_days";
  if (delta <= 30 * 86_400_000) return "due_within_30_days";
  return "later";
}

function timeline(shoppingCase, evaluatedAt) {
  const protection = protectionFor(shoppingCase);
  const names = ["return_deadline", "warranty_registration_deadline", "buyer_protection_deadline", "warranty_expiration"];
  return names.map((type) => ({ type, at: protection.deadlines[type], status: deadlineStatus(protection.deadlines[type], evaluatedAt) }));
}

function publicCase(shoppingCase, evaluatedAt, includeEvidence = false, includeEvents = false) {
  const protection = protectionFor(shoppingCase);
  const { signature: ignored, protection_candidate: candidate, evidence, events, ...safe } = shoppingCase;
  return {
    ...safe,
    protection,
    timeline: timeline(shoppingCase, evaluatedAt),
    evidence: includeEvidence ? evidence : undefined,
    evidence_count: evidence.length,
    events: includeEvents ? events : undefined,
    event_count: events.length,
  };
}

function signatureFor(input, order) {
  return crypto.createHash("sha256").update(JSON.stringify({
    merchant: clean(input.merchant, 300).toLowerCase(),
    order_number: order.order_number,
    purchased_at: order.purchased_at,
    identity: canonicalizeProductIdentity(input.identity),
  })).digest("hex");
}

export async function createShoppingCase(input, env = process.env, clock = Date.now) {
  const persistenceIntent = validatePersistenceIntent(input.request_receipt);
  const evaluatedAt = clock();
  const order = normalizeOrder(input.order);
  const evidence = normalizeEvidence(input.evidence, evaluatedAt, input.max_case_evidence_age_seconds ?? 300);
  if (!clean(input.merchant, 300)) fail("Merchant is required", "shopping_case_merchant_required");
  const canonicalIdentity = canonicalizeProductIdentity(input.identity || {});
  const stableIdentity = canonicalIdentity.identifiers.trade_item_code || canonicalIdentity.identifiers.mpn || canonicalIdentity.model || (canonicalIdentity.brand && canonicalIdentity.product_line);
  if (!stableIdentity) fail("A stable product identity is required", "shopping_case_identity_required");
  const protectionCandidate = protectionCandidateFromArtifact(input, evaluatedAt);
  if (!protectionCandidate?.returns || !protectionCandidate?.warranty || !protectionCandidate?.repairability) {
    fail("Exact-offer protection evidence is required", "shopping_case_protection_required");
  }
  validateOrderReceipt(input, order, evidence);
  const signature = signatureFor(input, order);
  return withLock(env, async (state) => {
    const existing = state.cases.find((item) => item.status !== "archived" && item.signature === signature);
    if (existing) return { write: false, value: { created: false, state_revision: state.revision, case: publicCase(existing, nowIso(clock)) } };
    if (state.cases.length >= MAX_CASES) fail("Stored shopping case limit reached", "shopping_case_storage_limit_reached");
    const timestamp = nowIso(clock);
    const shoppingCase = {
      id: `case_${crypto.randomUUID()}`,
      revision: 1,
      status: "open",
      label: clean(input.label, 200) || null,
      merchant: clean(input.merchant, 300),
      seller: clean(input.seller, 300) || null,
      identity: input.identity,
      canonical_identity: canonicalizeProductIdentity(input.identity),
      order,
      protection_candidate: protectionCandidate,
      serial_number: clean(input.serial_number, 300) || null,
      signature,
      evidence,
      evidence_trust: "process_attested",
      events: [],
      persistence_consent: { request_artifact_id: persistenceIntent.artifact_id, request_message_sha256: persistenceIntent.message_sha256, recorded_at: timestamp },
      created_at: timestamp,
      updated_at: timestamp,
    };
    state.cases.push(shoppingCase);
    return { value: { created: true, state_revision: state.revision + 1, case: publicCase(shoppingCase, timestamp) } };
  });
}

export async function listShoppingCases(input = {}, env = process.env, clock = Date.now) {
  const state = await readState(env);
  const evaluatedAt = input.evaluated_at || nowIso(clock);
  if (!validDate(evaluatedAt)) fail("Evaluation timestamp is invalid", "shopping_case_evaluation_date_invalid");
  const statuses = input.include_archived === true ? null : new Set(input.statuses || ["open", "resolved"]);
  let cases = state.cases.filter((item) => !statuses || statuses.has(item.status));
  if (Number.isFinite(input.due_within_days)) {
    const limit = input.due_within_days * 86_400_000;
    cases = cases.filter((item) => timeline(item, evaluatedAt).some((deadline) => deadline.at && Date.parse(deadline.at) >= Date.parse(evaluatedAt) && Date.parse(deadline.at) - Date.parse(evaluatedAt) <= limit));
  }
  return { state_revision: state.revision, evaluated_at: new Date(evaluatedAt).toISOString(), cases: cases.map((item) => publicCase(item, evaluatedAt, input.include_evidence === true, input.include_events === true)) };
}

export async function updateShoppingCase(input, env = process.env, clock = Date.now) {
  const mutationAt = clock();
  return withLock(env, async (state) => {
    const shoppingCase = state.cases.find((item) => item.id === input.case_id);
    if (!shoppingCase) fail("Shopping case not found", "shopping_case_not_found");
    if (input.expected_revision != null && input.expected_revision !== shoppingCase.revision) fail("Shopping case changed since it was read", "shopping_case_revision_conflict");
    if (input.status) shoppingCase.status = input.status;
    if (input.label !== undefined) shoppingCase.label = clean(input.label, 200) || null;
    if (input.serial_number !== undefined) shoppingCase.serial_number = clean(input.serial_number, 300) || null;
    if (input.delivered_at !== undefined || input.event !== undefined) fail("Consequential case changes require signed event evidence", "shopping_case_event_evidence_required");
    if (input.evidence?.length) {
      const additions = normalizeEvidence(input.evidence, mutationAt, input.max_case_evidence_age_seconds ?? 300);
      if (shoppingCase.evidence.length + additions.length > MAX_EVIDENCE) fail("Evidence exceeds the bounded case limit", "shopping_case_evidence_invalid");
      const ids = new Set(shoppingCase.evidence.map((item) => item.id));
      if (additions.some((item) => ids.has(item.id) || (ids.add(item.id), false))) fail("Evidence identifiers must be unique within a case", "shopping_case_evidence_duplicate");
      shoppingCase.evidence.push(...additions);
    }
    if (input.event_evidence) {
      if (!validateShoppingCaseEventEvidence(input.event_evidence, mutationAt, input.max_event_evidence_age_seconds ?? 300)) fail("Case event evidence is forged, stale, or altered", "shopping_case_event_evidence_invalid");
      if (!same(input.event_evidence.order_number, shoppingCase.order.order_number) || !same(input.event_evidence.product_id, shoppingCase.identity?.id || shoppingCase.identity?.product_id)) fail("Case event evidence covers another order or product", "shopping_case_event_evidence_scope");
      if (Date.parse(input.event_evidence.at) < Date.parse(shoppingCase.order.purchased_at)) fail("Case event predates the purchase", "shopping_case_event_evidence_time_invalid");
      if (shoppingCase.events.some((item) => item.id === input.event_evidence.event_evidence_id || item.artifact_attestation === input.event_evidence.artifact_attestation)) fail("Case event evidence was already recorded", "shopping_case_event_evidence_duplicate");
      if (shoppingCase.events.length >= MAX_EVENTS) fail("Case event limit reached", "shopping_case_event_limit_reached");
      const eventAt = input.event_evidence.at;
      shoppingCase.events.push({ id: input.event_evidence.event_evidence_id, type: input.event_evidence.type, at: eventAt, note: "", reference: clean(input.event_evidence.reference, 500) || null, counterparty: clean(input.event_evidence.counterparty, 500) || null, source_url: input.event_evidence.source_url, artifact_attestation: input.event_evidence.artifact_attestation, evidence_trust: "process_attested" });
      if (input.event_evidence.type === "delivered") shoppingCase.order.delivered_at = eventAt;
    }
    if (input.note) {
      if (shoppingCase.events.length >= MAX_EVENTS) fail("Case event limit reached", "shopping_case_event_limit_reached");
      shoppingCase.events.push({ id: `event_${crypto.randomUUID()}`, type: "note", at: nowIso(clock), note: clean(input.note.text), reference: clean(input.note.reference, 500) || null });
    }
    shoppingCase.revision += 1;
    shoppingCase.updated_at = nowIso(clock);
    return { value: { state_revision: state.revision + 1, case: publicCase(shoppingCase, shoppingCase.updated_at, true, true) } };
  });
}

function actionDeadline(protection, action) {
  if (action === "return") return protection.deadlines.return_deadline;
  if (action === "warranty_claim") return protection.deadlines.warranty_expiration;
  return protection.deadlines.buyer_protection_deadline;
}

export async function prepareShoppingCaseAction(input, env = process.env, clock = Date.now) {
  const state = await readState(env);
  const shoppingCase = state.cases.find((item) => item.id === input.case_id);
  if (!shoppingCase) fail("Shopping case not found", "shopping_case_not_found");
  const evaluatedAt = input.evaluated_at || nowIso(clock);
  if (!validDate(evaluatedAt)) fail("Evaluation timestamp is invalid", "shopping_case_evaluation_date_invalid");
  const protection = protectionFor(shoppingCase);
  const deadline = actionDeadline(protection, input.action);
  const missing = [];
  const blockers = [];
  if (!clean(input.problem)) missing.push("problem_description");
  if (!clean(input.requested_resolution)) missing.push("requested_resolution");
  if (!shoppingCase.evidence.some((item) => item.type === "order_receipt" && item.verified)) missing.push("verified_order_receipt");
  if (!deadline) missing.push(`${input.action}_deadline`);
  else if (Date.parse(deadline) < Date.parse(evaluatedAt)) blockers.push("deadline_expired");
  if (input.action === "return") {
    const returns = candidateFor(shoppingCase).returns || {};
    if (returns.final_sale === true || returns.opened_items === "not_accepted") blockers.push("return_policy_ineligible");
    if (!shoppingCase.evidence.some((item) => item.type === "merchant_policy" && item.verified)) missing.push("verified_return_policy");
  }
  if (input.action === "warranty_claim") {
    if (protection.warranty_validity.status !== "valid") blockers.push(`warranty_${protection.warranty_validity.status}`);
    if (!shoppingCase.serial_number) missing.push("serial_number");
    if (!shoppingCase.evidence.some((item) => item.type === "manufacturer_policy" && item.verified)) missing.push("verified_warranty_policy");
  }
  if (input.action === "buyer_protection" && !shoppingCase.events.some((event) => event.type === "merchant_contacted" && event.evidence_trust === "process_attested")) missing.push("merchant_contact_attempt");
  const ready = missing.length === 0 && blockers.length === 0;
  return {
    case_id: shoppingCase.id,
    action: input.action,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    readiness: ready ? "ready_for_user_review" : blockers.length ? "blocked" : "needs_evidence",
    deadline,
    deadline_status: deadlineStatus(deadline, evaluatedAt),
    missing: [...new Set(missing)],
    blockers: [...new Set(blockers)],
    package: {
      merchant: shoppingCase.merchant,
      seller: shoppingCase.seller,
      order_number: shoppingCase.order.order_number,
      product: shoppingCase.canonical_identity,
      serial_number: shoppingCase.serial_number,
      purchased_at: shoppingCase.order.purchased_at,
      delivered_at: shoppingCase.order.delivered_at,
      problem: clean(input.problem),
      requested_resolution: clean(input.requested_resolution, 500),
      evidence_ids: shoppingCase.evidence.map((item) => item.id),
    },
    draft_only: true,
    submission_allowed: false,
    requires_new_explicit_confirmation_before_external_submission: true,
  };
}
