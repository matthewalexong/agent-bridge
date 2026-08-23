import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const TYPE_BY_KIND = Object.freeze({ order_receipt: "order_receipt", return_policy: "merchant_policy", manufacturer_warranty: "manufacturer_policy" });

function coded(message, code) { return Object.assign(new Error(message), { code }); }

function explicit(fact) { return fact?.status === "explicit" ? fact.value : null; }

export function createShoppingCaseEvidence({ page_evidence, evaluated_at = Date.now(), max_age_seconds = 300 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  const capturedAt = Date.parse(page_evidence?.source?.captured_at || "");
  const receiptAt = Date.parse(page_evidence?.source_receipt?.captured_at || "");
  const kind = page_evidence?.source?.page_kind;
  const type = TYPE_BY_KIND[kind];
  if (!type || !verifyShoppingArtifactAttestation("page_evidence", page_evidence)
    || !verifyShoppingArtifactAttestation("browser_snapshot", page_evidence?.source_receipt)
    || page_evidence?.source_receipt?.truncated === true
    || page_evidence?.source?.url !== page_evidence?.source_receipt?.url
    || capturedAt !== receiptAt || !Number.isFinite(evaluatedAt) || !Number.isFinite(capturedAt)
    || capturedAt > evaluatedAt + 5_000 || evaluatedAt - capturedAt > max_age_seconds * 1_000) {
    throw coded("Fresh complete signed page evidence is required for a case record", "shopping_case_page_evidence_invalid");
  }
  const marker = kind === "order_receipt" ? "order_receipt" : kind === "return_policy" ? "return_policy" : "warranty";
  if (page_evidence.facts?.document_markers?.[marker]?.value !== true) throw coded("The signed page lacks the required document marker", "shopping_case_page_evidence_scope");
  const order = page_evidence.facts?.order || {};
  if (kind === "order_receipt" && (!explicit(order.order_number) || !explicit(order.product_id) || !explicit(order.purchased_at) || explicit(order.total_usd) == null)) {
    throw coded("The signed order receipt lacks exact order, product, purchase-time, or total fields", "shopping_case_order_receipt_incomplete");
  }
  const markerEvidence = page_evidence.facts.document_markers[marker].evidence || [];
  return attestShoppingArtifact("case_evidence", {
    evidence_id: `case_evidence_${page_evidence.source_receipt.content_sha256.slice(0, 24)}_${type}`,
    type,
    verified: true,
    source_url: page_evidence.source.url,
    captured_at: page_evidence.source.captured_at,
    excerpt: markerEvidence[0]?.excerpt || `${kind} verified from signed page evidence`,
    facts: {
      seller: explicit(page_evidence.facts?.seller),
      merchant_of_record: explicit(page_evidence.facts?.merchant_of_record),
      order: Object.fromEntries(Object.entries(order).map(([key, value]) => [key, explicit(value)])),
    },
    source_evidence: page_evidence,
  });
}

export function validateShoppingCaseEvidence(artifact, evaluated_at = null, max_age_seconds = 300) {
  const page = artifact?.source_evidence;
  const expectedType = TYPE_BY_KIND[page?.source?.page_kind];
  const evaluatedAt = evaluated_at == null ? null : (typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || ""));
  const capturedAt = Date.parse(artifact?.captured_at || "");
  return verifyShoppingArtifactAttestation("case_evidence", artifact)
    && verifyShoppingArtifactAttestation("page_evidence", page)
    && verifyShoppingArtifactAttestation("browser_snapshot", page?.source_receipt)
    && page?.source_receipt?.truncated !== true
    && expectedType === artifact?.type
    && artifact?.verified === true
    && artifact?.source_url === page?.source?.url
    && artifact?.captured_at === page?.source?.captured_at
    && (evaluatedAt == null || Number.isFinite(evaluatedAt) && Number.isFinite(capturedAt) && capturedAt <= evaluatedAt + 5_000 && evaluatedAt - capturedAt <= max_age_seconds * 1_000);
}
