import assert from "node:assert/strict";
import test from "node:test";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { extractShoppingPageEvidence } from "../lib/shopping-page-evidence.mjs";
import { assessShoppingSafetyFromEvidence } from "../lib/shopping-safety-evidence.mjs";
import { resolveShoppingSourceAuthority } from "../lib/shopping-source-authority.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function page(kind, url, text, id) {
  const receipt = attestShoppingArtifact("browser_snapshot", {
    source_id: id, snapshot_id: id, tab_id: 1, url, captured_at: NOW, truncated: false, content_sha256: "a".repeat(64),
  });
  return attestShoppingArtifact("page_evidence", {
    ...extractShoppingPageEvidence({ page_text: text, url, captured_at: NOW, page_kind: kind }), source_receipt: receipt,
  });
}

function identityArtifact(product_category = "electric_kettles") {
  return attestShoppingArtifact("identity", {
    evaluated_at: NOW, target_product_id: "acme-kettle-k1", product_category,
    canonical_target: { model: "k1", identifiers: { trade_item_code: "12345678905", mpn: "k1" } },
    resolutions: [{ candidate_id: "offer-a", classification: "exact_match", safe_to_compare_offers: true, offer_variant: null, canonical: { condition: "new" } }],
  });
}
const identity = identityArtifact();
const listing = page("retailer_listing", "https://shop.example/k1", "Sold by: Kettle Shop\nCondition: new", "listing");
const coverageText = "CPSC Recall Search\nAuthority: CPSC\nJurisdiction: US\nProduct Category: electric kettles\nProduct Key: acme-kettle-k1\nSearch Status: complete\nNo recalls found";

function assess(coverage, overrides = {}) {
  return assessShoppingSafetyFromEvidence({
    evaluated_at: NOW, jurisdiction: "US",
    identity, coverage_evidence: [{ authority_id: "CPSC", evidence: coverage }],
    candidates: [{ id: "offer-a", listing_evidence: listing }], ...overrides,
  });
}

test("registered authority domain plus signed exact-scope coverage clears safety research", () => {
  const result = assess(page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText, "cpsc-search"));
  assert.equal(result.assessments[0].action, "eligible");
  assert.equal(result.assessments[0].coverage_results[0].source_id, "cpsc-search");
});

test("hostname matching accepts real subdomains but rejects suffix-confusion domains", () => {
  assert.equal(resolveShoppingSourceAuthority({ authority_id: "CPSC", url: "https://recalls.cpsc.gov/search", jurisdiction: "US" })?.authority_id, "CPSC");
  assert.equal(resolveShoppingSourceAuthority({ authority_id: "CPSC", url: "https://cpsc.gov.attacker.example/search", jurisdiction: "US" }), null);
  assert.throws(() => assess(page("safety_authority_search", "https://cpsc.gov.attacker.example/Recalls", coverageText, "spoof")), { code: "shopping_safety_authority_untrusted" });
});

test("generic or mismatched search pages cannot assert complete exact-product coverage", () => {
  const generic = page("safety_authority_search", "https://www.cpsc.gov/Recalls", "CPSC Recall Search\nAuthority: CPSC\nJurisdiction: US\nSearch Status: complete", "generic");
  assert.throws(() => assess(generic), { code: "shopping_safety_coverage_incomplete" });
  const wrong = page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText.replace("acme-kettle-k1", "other-product"), "wrong");
  assert.equal(assess(wrong).assessments[0].action, "research_more");
});

test("signed official notice facts bind an active exact-product recall", () => {
  const notice = page("safety_notice", "https://www.cpsc.gov/Recalls/2026/R1", [
    "Recall Notice", "Recall ID: R1", "Notice Type: recall", "Notice Status: active", "Severity: serious",
    "Affected Product Key: acme-kettle-k1", "Affected Models: K1", "Affected Jurisdictions: US", "Scope Complete: yes",
  ].join("\n"), "cpsc-r1");
  const result = assess(page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText, "cpsc-search-2"), {
    notice_evidence: [{ authority_id: "CPSC", evidence: notice }],
  });
  assert.equal(result.assessments[0].action, "avoid_product");
  assert.ok(result.assessments[0].blockers.includes("notice:R1:active_unremediated_recall"));
});

test("certification and exact-unit remediation are reconstructed only from registered authority pages", () => {
  const coverage = page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText, "cpsc-search-3");
  const notice = page("safety_notice", "https://www.cpsc.gov/Recalls/2026/R1", [
    "Recall Notice", "Recall ID: R1", "Notice Type: recall", "Notice Status: active", "Severity: serious",
    "Affected Product Key: acme-kettle-k1", "Affected Models: K1", "Affected Jurisdictions: US", "Scope Complete: yes",
  ].join("\n"), "cpsc-r1-cert");
  const certification = page("certification_directory", "https://productiq.ul.com/search", [
    "Certification Scheme: UL", "Certification Jurisdiction: US", "Certification Status: valid",
    "Applies To Exact Model: yes", "Certification Expires: 2027-08-22T20:00:00.000Z",
  ].join("\n"), "ul-k1");
  const remediation = page("safety_remediation", "https://www.cpsc.gov/Recalls/2026/R1/remediation", [
    "Remediation Notice ID: R1", "Remediation Status: completed", "Restores Compliance: yes",
  ].join("\n"), "cpsc-r1-remediation");
  const result = assess(coverage, {
    certification_requirements: [{ scheme: "UL", jurisdiction: "US" }],
    notice_evidence: [{ authority_id: "CPSC", evidence: notice }],
    candidates: [{ id: "offer-a", listing_evidence: listing, certification_evidence: [{ scheme: "UL", authority_id: "UL", evidence: certification }], remediation_evidence: [{ authority_id: "CPSC", evidence: remediation }] }],
  });
  assert.equal(result.assessments[0].action, "eligible");
  assert.deepEqual(result.assessments[0].warnings, ["notice:R1:verified_remediation_completed"]);
  assert.equal(result.assessments[0].certification_results[0].status, "valid");
});

test("signed identity category selects FDA and cannot be weakened with CPSC-only coverage", () => {
  const wrongAuthority = page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText.replace("electric kettles", "dietary supplements"), "cpsc-food");
  const result = assess(wrongAuthority, { identity: identityArtifact("dietary_supplements") });
  assert.deepEqual(result.authority_policy.authorities, ["FDA"]);
  assert.equal(result.assessments[0].action, "research_more");
  assert.deepEqual(result.assessments[0].research, ["coverage:fda:missing"]);
});

test("process policy routes vehicles to NHTSA and ambiguous health devices to both authorities", () => {
  const nhtsa = page("safety_authority_search", "https://www.nhtsa.gov/recalls", coverageText
    .replaceAll("CPSC", "NHTSA").replace("electric kettles", "vehicle tires"), "nhtsa-tires");
  let result = assess(nhtsa, { identity: identityArtifact("vehicle_tires"), coverage_evidence: [{ authority_id: "NHTSA", evidence: nhtsa }] });
  assert.deepEqual(result.authority_policy.authorities, ["NHTSA"]);
  assert.equal(result.assessments[0].action, "eligible");

  const fda = page("safety_authority_search", "https://www.fda.gov/safety/recalls", coverageText
    .replaceAll("CPSC", "FDA").replace("electric kettles", "health devices"), "fda-health");
  const cpsc = page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText.replace("electric kettles", "health devices"), "cpsc-health");
  result = assess(cpsc, { identity: identityArtifact("health_devices"), coverage_evidence: [{ authority_id: "FDA", evidence: fda }, { authority_id: "CPSC", evidence: cpsc }] });
  assert.deepEqual(result.authority_policy.authorities, ["CPSC", "FDA"]);
  assert.equal(result.assessments[0].action, "eligible");
});

test("broad categories and unsupported jurisdiction policies fail closed", () => {
  const coverage = page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText, "broad");
  assert.throws(() => assess(coverage, { identity: identityArtifact("other") }), { code: "shopping_safety_authority_policy_unresolved" });
  assert.throws(() => assess(coverage, { jurisdiction: "CA" }), { code: "shopping_safety_authority_policy_unresolved" });
});

test("caller category substitution is ignored and missing signed category fails closed", () => {
  const coverage = page("safety_authority_search", "https://www.cpsc.gov/Recalls", coverageText, "category-substitution");
  const result = assess(coverage, { product_category: "dietary_supplements" });
  assert.equal(result.product_category, "electric_kettles");
  assert.deepEqual(result.authority_policy.authorities, ["CPSC"]);
  const missing = identityArtifact();
  delete missing.product_category;
  missing.artifact_attestation = attestShoppingArtifact("identity", { ...missing, artifact_attestation: undefined }).artifact_attestation;
  assert.throws(() => assess(coverage, { identity: missing }), { code: "shopping_safety_category_unresolved" });
  const forged = identityArtifact();
  forged.product_category = "dietary_supplements";
  assert.throws(() => assess(coverage, { identity: forged, candidates: [] }), { code: "shopping_safety_identity_invalid" });
});
