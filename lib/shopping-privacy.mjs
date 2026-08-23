const clean = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const unique = (items) => [...new Set(items)];
const OFFICIAL_INCIDENT_SOURCES = new Set(["regulator", "court", "manufacturer", "independent_security_lab"]);

function verified(item) {
  return item?.evidence_status === "verified" && clean(item.source_id);
}

function requireFact(candidate, path, item, unknowns) {
  if (!verified(item) || item.value == null || item.value === "unknown") {
    unknowns.push(`${candidate.id}:${path}`);
    return null;
  }
  return item.value;
}

function assessCandidate(input, candidate, evaluatedAt) {
  const failures = [];
  const unknowns = [];
  const clarifications = [];
  const warnings = [];
  const requirements = input.requirements || {};
  if (candidate.identity_verified !== true) unknowns.push(`${candidate.id}:identity`);

  const policyCaptured = Date.parse(candidate.policy?.captured_at);
  const maxAge = (input.policy?.max_policy_age_days ?? 30) * 86_400_000;
  if (!verified(candidate.policy) || !Number.isFinite(policyCaptured)) unknowns.push(`${candidate.id}:policy_source`);
  else if (policyCaptured > evaluatedAt + 300_000 || evaluatedAt - policyCaptured > maxAge) unknowns.push(`${candidate.id}:policy_stale`);
  if (candidate.policy?.inventory_complete !== true) unknowns.push(`${candidate.id}:data_inventory_complete`);

  const flows = candidate.data_flows || [];
  for (const flow of flows) {
    const key = clean(flow.category || "unknown");
    if (!verified(flow)) { unknowns.push(`${candidate.id}:data_flow:${key}`); continue; }
    if (!flow.collection || flow.collection === "unknown") { unknowns.push(`${candidate.id}:collection_status:${key}`); continue; }
    if (requirements.prohibited_data_categories?.map(clean).includes(key)) {
      if (flow.collection === "required") failures.push(`${candidate.id}:prohibited_required_data:${key}`);
      else if (flow.collection === "optional" && flow.can_disable !== true) unknowns.push(`${candidate.id}:optional_data_disable:${key}`);
    }
    if (requirements.prohibit_targeted_ads === true) {
      if (flow.targeted_ads === true) failures.push(`${candidate.id}:targeted_ads:${key}`);
      else if (flow.targeted_ads == null) unknowns.push(`${candidate.id}:targeted_ads:${key}`);
    }
    if (requirements.prohibit_data_sale === true) {
      if (flow.data_sale === true) failures.push(`${candidate.id}:data_sale:${key}`);
      else if (flow.data_sale == null) unknowns.push(`${candidate.id}:data_sale:${key}`);
    }
    if (requirements.allowed_third_party_purposes?.length && flow.third_party_sharing === true) {
      const disallowed = (flow.third_party_purposes || []).filter((purpose) => !requirements.allowed_third_party_purposes.map(clean).includes(clean(purpose)));
      if (disallowed.length) failures.push(`${candidate.id}:disallowed_sharing:${key}:${disallowed.map(clean).join("+")}`);
      if (!flow.third_party_purposes?.length) unknowns.push(`${candidate.id}:sharing_purpose:${key}`);
    }
    if (Number.isFinite(requirements.max_retention_days)) {
      if (flow.retention === "indefinite") failures.push(`${candidate.id}:indefinite_retention:${key}`);
      else if (!Number.isFinite(flow.retention_days)) unknowns.push(`${candidate.id}:retention:${key}`);
      else if (flow.retention_days > requirements.max_retention_days) failures.push(`${candidate.id}:retention_exceeds_limit:${key}`);
    }
  }

  const architecture = candidate.architecture || {};
  const accountRequired = requireFact(candidate, "account_required", architecture.account_required, unknowns);
  const cloudRequired = requireFact(candidate, "cloud_required", architecture.cloud_required, unknowns);
  const localCore = requireFact(candidate, "local_core_operation", architecture.local_core_operation, unknowns);
  if (requirements.account_optional_required === true && accountRequired === true) failures.push(`${candidate.id}:account_required`);
  if (requirements.local_core_operation_required === true) {
    if (localCore === false || cloudRequired === true) failures.push(`${candidate.id}:local_core_operation_unavailable`);
  }

  const controls = candidate.controls || {};
  const deletion = requireFact(candidate, "account_and_data_deletion", controls.account_and_data_deletion, unknowns);
  const exportAvailable = requireFact(candidate, "data_export", controls.data_export, unknowns);
  const consentWithdrawal = requireFact(candidate, "consent_withdrawal", controls.consent_withdrawal, unknowns);
  if (requirements.deletion_required === true && deletion !== true) failures.push(`${candidate.id}:deletion_unavailable`);
  if (requirements.export_required === true && exportAvailable !== true) failures.push(`${candidate.id}:export_unavailable`);
  if (requirements.consent_withdrawal_required === true && consentWithdrawal !== true) failures.push(`${candidate.id}:consent_withdrawal_unavailable`);
  if (Number.isFinite(requirements.max_deletion_days)) {
    if (!Number.isFinite(controls.deletion_days?.value) || !verified(controls.deletion_days)) unknowns.push(`${candidate.id}:deletion_timing`);
    else if (controls.deletion_days.value > requirements.max_deletion_days) failures.push(`${candidate.id}:deletion_too_slow`);
  }

  const security = candidate.security || {};
  for (const [requirement, field] of [["encryption_in_transit_required", "encryption_in_transit"], ["encryption_at_rest_required", "encryption_at_rest"], ["mfa_required", "mfa_available"]]) {
    if (requirements[requirement] !== true) continue;
    const value = requireFact(candidate, field, security[field], unknowns);
    if (value === false) failures.push(`${candidate.id}:${field}_unavailable`);
  }

  const prohibitedPermissions = new Set((requirements.prohibited_required_permissions || []).map(clean));
  for (const permission of candidate.permissions || []) {
    const key = clean(permission.name);
    if (!verified(permission)) { unknowns.push(`${candidate.id}:permission:${key}`); continue; }
    if (permission.required_for_core === true && prohibitedPermissions.has(key)) failures.push(`${candidate.id}:prohibited_required_permission:${key}`);
    if (permission.required_for_core === true && !clean(permission.justification)) unknowns.push(`${candidate.id}:permission_justification:${key}`);
  }

  const transfer = candidate.transfer || {};
  if (requirements.secure_resale_required === true) {
    const reset = requireFact(candidate, "factory_reset", transfer.factory_reset, unknowns);
    const unlink = requireFact(candidate, "account_unlink", transfer.account_unlink, unknowns);
    const ownership = requireFact(candidate, "ownership_transfer", transfer.ownership_transfer, unknowns);
    if ([reset, unlink, ownership].some((value) => value === false)) failures.push(`${candidate.id}:secure_resale_unavailable`);
  }

  const incidentResults = [];
  for (const incident of candidate.incidents || []) {
    if (incident.evidence_status !== "verified" || !OFFICIAL_INCIDENT_SOURCES.has(incident.source_type) || !clean(incident.source_id)) {
      incidentResults.push({ id: incident.id, status: "excluded", reason: "incident_not_verified_official_evidence" });
      continue;
    }
    if (incident.applies_to_exact_product !== true) { incidentResults.push({ id: incident.id, status: "not_applicable" }); continue; }
    incidentResults.push({ id: incident.id, status: "applicable", severity: incident.severity, resolved: incident.resolved, source_id: incident.source_id });
    if (incident.resolved !== true && ["critical", "serious"].includes(incident.severity)) failures.push(`${candidate.id}:unresolved_${incident.severity}_incident:${incident.id}`);
    else if (incident.resolved !== true && incident.severity === "moderate") clarifications.push(`${candidate.id}:moderate_privacy_incident:${incident.id}`);
    else if (incident.resolved == null || incident.severity === "unknown") unknowns.push(`${candidate.id}:incident_status:${incident.id}`);
  }

  if (flows.some((flow) => flow.collection === "required")) warnings.push(`${candidate.id}:required_data_collection_present`);
  const normalizedFailures = unique(failures);
  const normalizedUnknowns = unique(unknowns);
  const normalizedClarifications = unique(clarifications);
  const action = normalizedFailures.length ? "reject" : normalizedUnknowns.length ? "research_more" : normalizedClarifications.length ? "clarify_tradeoff" : "eligible";
  return { id: candidate.id, action, blockers: normalizedFailures, research: normalizedUnknowns, clarifications: normalizedClarifications, warnings: unique(warnings), incident_results: incidentResults, privacy_cleared_for_ranking: action === "eligible", purchase_allowed: false };
}

export function assessShoppingPrivacy(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Privacy evaluation timestamp is invalid"), { code: "shopping_privacy_invalid" });
  const assessments = (input.candidates || []).map((candidate) => assessCandidate(input, candidate, evaluatedAt));
  return {
    evaluated_at: new Date(evaluatedAt).toISOString(),
    assessments,
    decision: {
      eligible_candidates: assessments.filter((item) => item.action === "eligible").map((item) => item.id),
      research_candidates: assessments.filter((item) => item.action === "research_more").map((item) => item.id),
      clarify_candidates: assessments.filter((item) => item.action === "clarify_tradeoff").map((item) => item.id),
      rejected_candidates: assessments.filter((item) => item.action === "reject").map((item) => item.id),
      selected_candidate: null,
      purchase_allowed: false,
    },
  };
}
