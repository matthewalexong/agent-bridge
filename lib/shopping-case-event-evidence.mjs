import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const ALLOWED = Object.freeze({
  merchant_correspondence: new Set(["merchant_contacted", "return_requested", "refund_received", "claim_opened", "claim_resolved"]),
  carrier_tracking: new Set(["delivered", "return_shipped"]),
  return_status: new Set(["return_requested", "return_shipped", "refund_received"]),
  warranty_status: new Set(["warranty_registered", "claim_opened", "claim_resolved"]),
});

function coded(message, code) { return Object.assign(new Error(message), { code }); }
const explicit = (fact) => fact?.status === "explicit" ? fact.value : null;

export function createShoppingCaseEventEvidence({ page_evidence, evaluated_at = Date.now(), max_age_seconds = 300 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  const capturedAt = Date.parse(page_evidence?.source?.captured_at || "");
  const receiptAt = Date.parse(page_evidence?.source_receipt?.captured_at || "");
  const kind = page_evidence?.source?.page_kind;
  const event = page_evidence?.facts?.case_event || {};
  const type = explicit(event.type);
  const eventAt = Date.parse(explicit(event.at) || "");
  if (!ALLOWED[kind]?.has(type) || !verifyShoppingArtifactAttestation("page_evidence", page_evidence)
    || !verifyShoppingArtifactAttestation("browser_snapshot", page_evidence?.source_receipt)
    || page_evidence?.source_receipt?.truncated === true
    || page_evidence?.source?.url !== page_evidence?.source_receipt?.url
    || capturedAt !== receiptAt || !Number.isFinite(evaluatedAt) || !Number.isFinite(capturedAt) || !Number.isFinite(eventAt)
    || capturedAt > evaluatedAt + 5_000 || evaluatedAt - capturedAt > max_age_seconds * 1_000 || eventAt > evaluatedAt + 5_000
    || page_evidence?.facts?.document_markers?.case_event?.value !== true
    || !explicit(event.order_number) || !explicit(event.product_id)) {
    throw coded("Fresh complete exact-order signed event evidence is required", "shopping_case_event_page_evidence_invalid");
  }
  return attestShoppingArtifact("case_event_evidence", {
    event_evidence_id: `case_event_${page_evidence.source_receipt.content_sha256.slice(0, 32)}`,
    type,
    at: new Date(eventAt).toISOString(),
    order_number: explicit(event.order_number),
    product_id: explicit(event.product_id),
    reference: explicit(event.reference),
    counterparty: explicit(event.counterparty),
    captured_at: page_evidence.source.captured_at,
    source_url: page_evidence.source.url,
    source_evidence: page_evidence,
    evaluated_at: new Date(evaluatedAt).toISOString(),
  });
}

export function validateShoppingCaseEventEvidence(artifact, evaluated_at = null, max_age_seconds = 300) {
  const page = artifact?.source_evidence;
  const event = page?.facts?.case_event || {};
  const evaluatedAt = evaluated_at == null ? null : (typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || ""));
  const artifactAt = Date.parse(artifact?.evaluated_at || "");
  const capturedAt = Date.parse(artifact?.captured_at || "");
  return verifyShoppingArtifactAttestation("case_event_evidence", artifact)
    && verifyShoppingArtifactAttestation("page_evidence", page)
    && verifyShoppingArtifactAttestation("browser_snapshot", page?.source_receipt)
    && page?.source_receipt?.truncated !== true
    && ALLOWED[page?.source?.page_kind]?.has(artifact?.type)
    && artifact?.type === explicit(event.type)
    && artifact?.at === explicit(event.at)
    && artifact?.order_number === explicit(event.order_number)
    && artifact?.product_id === explicit(event.product_id)
    && artifact?.captured_at === page?.source?.captured_at
    && artifact?.source_url === page?.source?.url
    && (evaluatedAt == null || Number.isFinite(evaluatedAt) && Number.isFinite(artifactAt) && Number.isFinite(capturedAt)
      && artifactAt <= evaluatedAt + 5_000 && evaluatedAt - artifactAt <= max_age_seconds * 1_000
      && capturedAt <= evaluatedAt + 5_000 && evaluatedAt - capturedAt <= max_age_seconds * 1_000);
}
