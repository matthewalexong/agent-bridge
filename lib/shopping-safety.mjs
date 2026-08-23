import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const clean = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const compact = (value) => clean(value).replaceAll(" ", "");
const unique = (items) => [...new Set(items)];
const OFFICIAL_NOTICE_AUTHORITIES = new Set(["regulator", "manufacturer"]);
const same = (a, b) => clean(a) === clean(b);

function validSource(item) {
  return item?.evidence_status === "verified" && OFFICIAL_NOTICE_AUTHORITIES.has(item.authority_type) && clean(item.source_id);
}

function serialInRange(serial, range) {
  const normalized = String(serial ?? "").trim().toUpperCase();
  const prefix = String(range.prefix ?? "").trim().toUpperCase();
  if (!normalized || !normalized.startsWith(prefix)) return false;
  const suffix = normalized.slice(prefix.length);
  if (!/^\d+$/.test(suffix) || !/^\d+$/.test(String(range.start)) || !/^\d+$/.test(String(range.end))) return false;
  if (String(range.start).length !== String(range.end).length || suffix.length !== String(range.start).length) return false;
  const value = BigInt(suffix);
  return value >= BigInt(range.start) && value <= BigInt(range.end);
}

function identifierMatch(expected = {}, actual = {}) {
  const entries = Object.entries(expected).filter(([, value]) => value != null && String(value).trim());
  if (!entries.length) return { applies: true };
  for (const [kind, value] of entries) {
    if (!actual[kind]) return { applies: null, reason: `missing_identifier:${kind}` };
    if (compact(actual[kind]) !== compact(value)) return { applies: false };
  }
  return { applies: true };
}

function noticeScope(notice, candidate, jurisdiction) {
  const scope = notice.affected || {};
  if (scope.jurisdictions?.length && !scope.jurisdictions.map((item) => item.toUpperCase()).includes(jurisdiction)) return { applies: false, reason: "jurisdiction_out_of_scope" };
  let selectorCount = 0;
  for (const [field, values] of [["product_key", scope.product_keys], ["model", scope.models]]) {
    if (!values?.length) continue;
    selectorCount += 1;
    if (!candidate[field]) return { applies: null, reason: `missing_${field}` };
    if (!values.some((value) => clean(value) === clean(candidate[field]))) return { applies: false, reason: `${field}_out_of_scope` };
  }
  if (scope.identifiers && Object.keys(scope.identifiers).length) {
    selectorCount += 1;
    const match = identifierMatch(scope.identifiers, candidate.identifiers);
    if (match.applies !== true) return match;
  }
  if (selectorCount === 0) return { applies: null, reason: "notice_product_scope_missing" };

  if (scope.serial_ranges?.length) {
    if (!candidate.serial_number) return { applies: null, reason: "serial_number_required" };
    if (!scope.serial_ranges.some((range) => serialInRange(candidate.serial_number, range))) return { applies: false, reason: "serial_out_of_scope" };
  }
  if (scope.manufactured_from || scope.manufactured_to) {
    const manufactured = Date.parse(candidate.manufactured_at);
    if (!Number.isFinite(manufactured)) return { applies: null, reason: "manufacture_date_required" };
    const from = scope.manufactured_from ? Date.parse(scope.manufactured_from) : -Infinity;
    const to = scope.manufactured_to ? Date.parse(scope.manufactured_to) : Infinity;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return { applies: null, reason: "notice_manufacture_range_invalid" };
    if (manufactured < from || manufactured > to) return { applies: false, reason: "manufacture_date_out_of_scope" };
  }
  if (scope.scope_complete !== true) return { applies: null, reason: "notice_scope_incomplete" };
  return { applies: true, reason: "exact_affected_scope_match" };
}

function remediation(candidate, notice) {
  const item = (candidate.remediations || []).find((entry) => entry.notice_id === notice.id);
  if (!item) return { cleared: false, reason: "remediation_not_completed" };
  if (item.status !== "completed") return { cleared: false, reason: `remediation_${item.status || "unknown"}` };
  if (item.evidence_status !== "verified" || !clean(item.source_id)) return { cleared: false, reason: "remediation_unverified" };
  if (item.restores_compliance !== true) return { cleared: false, reason: "remediation_clearance_unverified" };
  return { cleared: true, reason: "verified_remediation_completed", source_id: item.source_id };
}

function certificationResults(candidate, requirements, evaluatedAt) {
  const results = [];
  for (const requirement of requirements || []) {
    const claim = (candidate.certifications || []).find((item) => clean(item.scheme) === clean(requirement.scheme) && clean(item.jurisdiction) === clean(requirement.jurisdiction));
    if (!claim) { results.push({ scheme: requirement.scheme, status: "research_more", reason: "certification_claim_missing" }); continue; }
    if (claim.evidence_status !== "verified" || !clean(claim.source_id) || claim.applies_to_exact_model !== true) { results.push({ scheme: requirement.scheme, status: "research_more", reason: "certification_not_verified_for_exact_model" }); continue; }
    if (["revoked", "expired", "invalid"].includes(claim.status)) { results.push({ scheme: requirement.scheme, status: "failed", reason: `certification_${claim.status}`, source_id: claim.source_id }); continue; }
    if (claim.status !== "valid") { results.push({ scheme: requirement.scheme, status: "research_more", reason: "certification_status_unknown" }); continue; }
    const expires = Date.parse(claim.expires_at);
    if (claim.expires_at && (!Number.isFinite(expires) || expires <= evaluatedAt)) { results.push({ scheme: requirement.scheme, status: "failed", reason: "certification_expired", source_id: claim.source_id }); continue; }
    results.push({ scheme: requirement.scheme, status: "valid", source_id: claim.source_id });
  }
  return results;
}

function coverageResults(input, candidate, evaluatedAt) {
  const maxAge = (input.policy?.max_coverage_age_days ?? 7) * 86_400_000;
  return (input.required_authorities || []).map((authorityId) => {
    const check = (input.coverage || []).find((item) => clean(item.authority_id) === clean(authorityId) && item.jurisdiction?.toUpperCase() === input.jurisdiction.toUpperCase() && clean(item.product_category) === clean(input.product_category));
    if (!check) return { authority_id: authorityId, status: "missing" };
    const searched = Date.parse(check.searched_at);
    if (!clean(check.source_id) || check.status !== "complete") return { authority_id: authorityId, status: "incomplete" };
    if (!Number.isFinite(searched) || searched > evaluatedAt + 300_000 || evaluatedAt - searched > maxAge) return { authority_id: authorityId, status: "stale" };
    if (check.product_key && clean(check.product_key) !== clean(candidate.product_key)) return { authority_id: authorityId, status: "scope_mismatch" };
    return { authority_id: authorityId, status: "complete", source_id: check.source_id, searched_at: new Date(searched).toISOString() };
  });
}

function assessCandidate(input, candidate, evaluatedAt) {
  const blockers = [];
  const research = [];
  const clarifications = [];
  const warnings = [];
  const noticeResults = [];
  if (candidate.identity_verified !== true) research.push("identity_not_verified_for_safety_scope");

  for (const notice of input.notices || []) {
    if (!validSource(notice)) {
      noticeResults.push({ notice_id: notice.id, match: "excluded", reason: "notice_not_verified_official_evidence" });
      continue;
    }
    const scope = noticeScope(notice, candidate, input.jurisdiction.toUpperCase());
    if (scope.applies === false) { noticeResults.push({ notice_id: notice.id, match: "not_affected", reason: scope.reason, source_id: notice.source_id }); continue; }
    if (scope.applies == null) { noticeResults.push({ notice_id: notice.id, match: "unknown", reason: scope.reason, source_id: notice.source_id }); research.push(`notice:${notice.id}:${scope.reason}`); continue; }
    const remedy = remediation(candidate, notice);
    noticeResults.push({ notice_id: notice.id, match: "affected", notice_type: notice.notice_type, severity: notice.severity, status: notice.status, remediation: remedy, source_id: notice.source_id });
    if (["sales_ban", "import_ban"].includes(notice.notice_type) && notice.status === "active") blockers.push(`notice:${notice.id}:${notice.notice_type}`);
    else if (["recall", "corrective_action"].includes(notice.notice_type) && notice.status === "active") {
      if (remedy.cleared) warnings.push(`notice:${notice.id}:verified_remediation_completed`);
      else blockers.push(`notice:${notice.id}:active_unremediated_${notice.notice_type}`);
    } else if (notice.notice_type === "safety_warning" && notice.status === "active") {
      if (["critical", "serious"].includes(notice.severity)) blockers.push(`notice:${notice.id}:active_${notice.severity}_warning`);
      else if (notice.severity === "moderate") clarifications.push(`notice:${notice.id}:moderate_safety_tradeoff`);
      else research.push(`notice:${notice.id}:severity_unknown`);
    } else if (notice.status === "unknown") research.push(`notice:${notice.id}:status_unknown`);
  }

  const certifications = certificationResults(candidate, input.certification_requirements, evaluatedAt);
  blockers.push(...certifications.filter((item) => item.status === "failed").map((item) => `certification:${clean(item.scheme).replaceAll(" ", "_")}:${item.reason}`));
  research.push(...certifications.filter((item) => item.status === "research_more").map((item) => `certification:${clean(item.scheme).replaceAll(" ", "_")}:${item.reason}`));
  const coverage = coverageResults(input, candidate, evaluatedAt);
  research.push(...coverage.filter((item) => item.status !== "complete").map((item) => `coverage:${clean(item.authority_id).replaceAll(" ", "_")}:${item.status}`));

  const normalizedBlockers = unique(blockers);
  const normalizedResearch = unique(research);
  const normalizedClarifications = unique(clarifications);
  const action = normalizedBlockers.length ? "avoid_product" : normalizedResearch.length ? "research_more" : normalizedClarifications.length ? "clarify_tradeoff" : "eligible";
  return { id: candidate.id, product_key: candidate.product_key, variant: candidate.variant ?? null, condition: candidate.condition || "new", seller: candidate.seller ?? null, serial_number: candidate.serial_number ?? null, action, notice_results: noticeResults, certification_results: certifications, coverage_results: coverage, blockers: normalizedBlockers, research: normalizedResearch, clarifications: normalizedClarifications, warnings: unique(warnings), safety_cleared_for_ranking: action === "eligible", purchase_allowed: false };
}

export function validateSafetyAssessment({ artifact, offer, jurisdiction = null, evaluated_at = Date.now(), max_age_seconds = 86_400 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  if (!verifyShoppingArtifactAttestation("safety", artifact)) return null;
  if (!artifact?.evaluated_at || !Array.isArray(artifact.assessments) || !Number.isFinite(evaluatedAt)) return null;
  const artifactAt = Date.parse(artifact.evaluated_at);
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > max_age_seconds * 1_000) return null;
  if (jurisdiction && !same(artifact.jurisdiction, jurisdiction)) return null;
  const assessment = artifact.assessments.find((candidate) => same(candidate?.id, offer?.id));
  if (!assessment || !same(assessment.product_key, offer?.product_key)) return null;
  if (offer?.variant != null && (!assessment.variant || !same(assessment.variant, offer.variant))) return null;
  if (!same(assessment.condition, offer?.condition || "new")) return null;
  if (!assessment.seller || !same(assessment.seller, offer?.seller)) return null;
  if ((assessment.serial_number || offer?.serial_number) && !same(assessment.serial_number, offer?.serial_number)) return null;
  if (!["eligible", "research_more", "clarify_tradeoff", "avoid_product"].includes(assessment.action)) return null;
  if (assessment.purchase_allowed !== false) return null;
  if ((assessment.action === "eligible") !== (assessment.safety_cleared_for_ranking === true)) return null;
  return assessment;
}

export function assessShoppingSafety(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Safety evaluation timestamp is invalid"), { code: "shopping_safety_invalid" });
  if (!/^[A-Za-z]{2}$/.test(input.jurisdiction || "")) throw Object.assign(new Error("Safety jurisdiction must be an ISO alpha-2 country code"), { code: "shopping_safety_invalid" });
  return attestShoppingArtifact("safety", { evaluated_at: new Date(evaluatedAt).toISOString(), jurisdiction: input.jurisdiction.toUpperCase(), product_category: input.product_category, authority_policy: input.authority_policy || null, assessments: (input.candidates || []).map((candidate) => assessCandidate(input, candidate, evaluatedAt)), purchase_allowed: false });
}
