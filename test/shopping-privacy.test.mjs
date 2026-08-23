import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingPrivacy } from "../lib/shopping-privacy.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const fact = (value, source_id = "official-policy") => ({ value, evidence_status: "verified", source_id });
const flow = (overrides = {}) => ({ category: "usage", collection: "required", can_disable: false, targeted_ads: false, data_sale: false, third_party_sharing: false, third_party_purposes: [], retention_days: 30, evidence_status: "verified", source_id: "official-policy", ...overrides });
const candidate = (overrides = {}) => ({
  id: "private", identity_verified: true,
  policy: { inventory_complete: true, captured_at: "2026-08-22T19:00:00.000Z", evidence_status: "verified", source_id: "official-policy" },
  data_flows: [flow()],
  architecture: { account_required: fact(false), cloud_required: fact(false), local_core_operation: fact(true) },
  controls: { account_and_data_deletion: fact(true), deletion_days: fact(7), data_export: fact(true), consent_withdrawal: fact(true) },
  security: { encryption_in_transit: fact(true, "security-whitepaper"), encryption_at_rest: fact(true, "security-whitepaper"), mfa_available: fact(true, "account-docs") },
  permissions: [],
  transfer: { factory_reset: fact(true, "manual"), account_unlink: fact(true, "manual"), ownership_transfer: fact(true, "manual") },
  incidents: [],
  ...overrides,
});
const requirements = (overrides = {}) => ({ prohibited_data_categories: ["location", "biometric"], prohibit_targeted_ads: true, prohibit_data_sale: true, max_retention_days: 90, account_optional_required: true, local_core_operation_required: true, deletion_required: true, export_required: true, consent_withdrawal_required: true, max_deletion_days: 30, encryption_in_transit_required: true, encryption_at_rest_required: true, mfa_required: true, secure_resale_required: true, ...overrides });
const assess = (item = candidate(), req = requirements()) => assessShoppingPrivacy({ evaluated_at: NOW, policy: { max_policy_age_days: 30 }, requirements: req, candidates: [item] }).assessments[0];

test("a sourced local product with bounded data controls clears ranking only", () => {
  const result = assess();
  assert.equal(result.action, "eligible");
  assert.equal(result.privacy_cleared_for_ranking, true);
  assert.equal(result.purchase_allowed, false);
  assert.deepEqual(result.warnings, ["private:required_data_collection_present"]);
});

test("required prohibited data collection rejects while verified disableable optional collection does not", () => {
  let result = assess(candidate({ data_flows: [flow({ category: "location", collection: "required" })] }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("private:prohibited_required_data:location"));
  result = assess(candidate({ data_flows: [flow(), flow({ category: "location", collection: "optional", can_disable: true })] }));
  assert.equal(result.action, "eligible");
});

test("optional prohibited collection without a verified off switch remains research", () => {
  const result = assess(candidate({ data_flows: [flow({ category: "location", collection: "optional", can_disable: null })] }));
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("private:optional_data_disable:location"));
});

test("targeted advertising and data sale independently violate user requirements", () => {
  const result = assess(candidate({ data_flows: [flow({ targeted_ads: true, data_sale: true })] }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("private:targeted_ads:usage"));
  assert.ok(result.blockers.includes("private:data_sale:usage"));
});

test("third-party purposes must stay inside the user's allowed set", () => {
  const req = requirements({ allowed_third_party_purposes: ["service_delivery"] });
  const result = assess(candidate({ data_flows: [flow({ third_party_sharing: true, third_party_purposes: ["service_delivery", "advertising"] })] }), req);
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.some((item) => item.includes("disallowed_sharing:usage:advertising")));
});

test("indefinite, excessive, and unknown retention never satisfy a maximum", () => {
  assert.equal(assess(candidate({ data_flows: [flow({ retention: "indefinite", retention_days: null })] })).action, "reject");
  assert.equal(assess(candidate({ data_flows: [flow({ retention_days: 365 })] })).action, "reject");
  assert.equal(assess(candidate({ data_flows: [flow({ retention_days: null })] })).action, "research_more");
});

test("account and cloud dependence cannot masquerade as local operation", () => {
  const result = assess(candidate({ architecture: { account_required: fact(true), cloud_required: fact(true), local_core_operation: fact(false) } }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("private:account_required"));
  assert.ok(result.blockers.includes("private:local_core_operation_unavailable"));
});

test("deletion, export, consent withdrawal, and timing are separate controls", () => {
  const result = assess(candidate({ controls: { account_and_data_deletion: fact(false), deletion_days: fact(90), data_export: fact(false), consent_withdrawal: fact(false) } }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("private:deletion_unavailable"));
  assert.ok(result.blockers.includes("private:export_unavailable"));
  assert.ok(result.blockers.includes("private:consent_withdrawal_unavailable"));
  assert.ok(result.blockers.includes("private:deletion_too_slow"));
});

test("transport encryption, storage encryption, and MFA are independent requirements", () => {
  const result = assess(candidate({ security: { encryption_in_transit: fact(true), encryption_at_rest: fact(false), mfa_available: fact(false) } }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("private:encryption_at_rest_unavailable"));
  assert.ok(result.blockers.includes("private:mfa_available_unavailable"));
});

test("required prohibited permissions reject and missing necessity explanations remain research", () => {
  let result = assess(candidate({ permissions: [{ name: "microphone", required_for_core: true, justification: "Voice control", evidence_status: "verified", source_id: "app-permissions" }] }), requirements({ prohibited_required_permissions: ["microphone"] }));
  assert.equal(result.action, "reject");
  result = assess(candidate({ permissions: [{ name: "bluetooth", required_for_core: true, evidence_status: "verified", source_id: "app-permissions" }] }));
  assert.equal(result.action, "research_more");
});

test("factory reset, unlink, and ownership transfer all matter for secure resale", () => {
  const result = assess(candidate({ transfer: { factory_reset: fact(true), account_unlink: fact(false), ownership_transfer: fact(true) } }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("private:secure_resale_unavailable"));
});

test("official unresolved incidents gate exact products while unverified reports are excluded", () => {
  const serious = { id: "INC1", severity: "serious", resolved: false, applies_to_exact_product: true, evidence_status: "verified", source_type: "regulator", source_id: "regulator-order" };
  let result = assess(candidate({ incidents: [serious] }));
  assert.equal(result.action, "reject");
  const rumor = { ...serious, evidence_status: "unknown", source_type: "customer_review" };
  result = assess(candidate({ incidents: [rumor] }));
  assert.equal(result.action, "eligible");
  assert.equal(result.incident_results[0].status, "excluded");
});

test("a verified moderate unresolved incident requires an explicit tradeoff", () => {
  const incident = { id: "INC2", severity: "moderate", resolved: false, applies_to_exact_product: true, evidence_status: "verified", source_type: "independent_security_lab", source_id: "lab-advisory" };
  const result = assess(candidate({ incidents: [incident] }));
  assert.equal(result.action, "clarify_tradeoff");
});

test("stale policy, incomplete inventory, unsourced facts, and unknown flow status remain research", () => {
  assert.equal(assess(candidate({ policy: { ...candidate().policy, captured_at: "2026-01-01T00:00:00.000Z" } })).action, "research_more");
  assert.equal(assess(candidate({ policy: { ...candidate().policy, inventory_complete: false } })).action, "research_more");
  assert.equal(assess(candidate({ architecture: { ...candidate().architecture, account_required: { value: false, evidence_status: "verified" } } })).action, "research_more");
  assert.equal(assess(candidate({ data_flows: [flow({ collection: "unknown" })] })).action, "research_more");
});

test("privacy assessment partitions candidates without selecting or buying", () => {
  const privateCandidate = candidate({ id: "yes" });
  const unknownCandidate = candidate({ id: "unknown", policy: { ...candidate().policy, inventory_complete: false } });
  const rejectedCandidate = candidate({ id: "no", data_flows: [flow({ targeted_ads: true })] });
  const result = assessShoppingPrivacy({ evaluated_at: NOW, requirements: requirements(), candidates: [privateCandidate, unknownCandidate, rejectedCandidate] });
  assert.deepEqual(result.decision.eligible_candidates, ["yes"]);
  assert.deepEqual(result.decision.research_candidates, ["unknown"]);
  assert.deepEqual(result.decision.rejected_candidates, ["no"]);
  assert.equal(result.decision.selected_candidate, null);
  assert.equal(result.decision.purchase_allowed, false);
});
