import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";
import { validateCounterfeitAssessment } from "../lib/shopping-counterfeit.mjs";
import { validateIdentityResolution } from "../lib/shopping-identity.mjs";
import { validateMerchantTrustAssessment } from "../lib/shopping-merchant-trust.mjs";
import { validateProtectionAssessment } from "../lib/shopping-protection.mjs";
import { validateSafetyAssessment } from "../lib/shopping-safety.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const offer = { id: "offer-a", product_key: "product-a", variant: "black", condition: "new", seller: "Seller A" };

const fixtures = {
  identity: { evaluated_at: NOW, target_product_id: "product-a", resolutions: [{ candidate_id: "offer-a", offer_variant: "black", classification: "exact_match", safe_to_compare_offers: true, canonical: { condition: "new" } }] },
  safety: { evaluated_at: NOW, jurisdiction: "US", assessments: [{ id: "offer-a", product_key: "product-a", variant: "black", condition: "new", seller: "Seller A", action: "eligible", safety_cleared_for_ranking: true, purchase_allowed: false }] },
  merchant: { evaluated_at: NOW, assessments: [{ id: "offer-a", status: "verified_established", purchase_gate: "eligible_for_other_shopping_checks", roles: { seller: { name: "Seller A" }, merchant_of_record: { name: "Merchant A" } } }] },
  counterfeit: { evaluated_at: NOW, assessments: [{ offer_id: "offer-a", product_id: "product-a", variant: "black", seller: "Seller A", risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", distinctions: { identity_exact: true, condition: "new" } }] },
  protection: { evaluated_at: NOW, assessments: [{ id: "offer-a", product_id: "product-a", variant: "black", condition: "new", seller: "Seller A", status: "eligible", purchase_gate: "eligible_for_offer_analysis" }] },
};

const validators = {
  identity: (artifact) => validateIdentityResolution({ artifact, offer, evaluated_at: NOW }),
  safety: (artifact) => validateSafetyAssessment({ artifact, offer, jurisdiction: "US", evaluated_at: NOW }),
  merchant: (artifact) => validateMerchantTrustAssessment({ artifact, offer, merchant_of_record: "Merchant A", evaluated_at: NOW }),
  counterfeit: (artifact) => validateCounterfeitAssessment({ artifact, offer, evaluated_at: NOW }),
  protection: (artifact) => validateProtectionAssessment({ artifact, offer, evaluated_at: NOW }),
};

test("each high-impact artifact requires its own valid process-issued attestation", () => {
  for (const kind of Object.keys(fixtures)) {
    const artifact = attestShoppingArtifact(kind, fixtures[kind]);
    assert.match(artifact.artifact_attestation, new RegExp(`^v1\\.${kind}\\.[a-f0-9]{64}$`));
    assert.equal(verifyShoppingArtifactAttestation(kind, artifact), true);
    assert.ok(validators[kind](artifact), `${kind} should validate with its exact attestation`);
    assert.equal(validators[kind](fixtures[kind]), null, `${kind} must reject unsigned lookalikes`);
  }
});

test("nested payload tampering and cross-domain replay fail closed", () => {
  for (const kind of Object.keys(fixtures)) {
    const artifact = attestShoppingArtifact(kind, fixtures[kind]);
    const tampered = structuredClone(artifact);
    const collection = tampered.assessments || tampered.resolutions;
    collection[0].injected_model_override = true;
    assert.equal(verifyShoppingArtifactAttestation(kind, tampered), false);
    assert.equal(validators[kind](tampered), null);
    const otherKind = kind === "identity" ? "safety" : "identity";
    assert.equal(verifyShoppingArtifactAttestation(otherKind, artifact), false);
  }
});

test("artifact authority expires across a harness process restart", () => {
  const artifact = attestShoppingArtifact("identity", fixtures.identity);
  const moduleUrl = new URL("../lib/shopping-attestation.mjs", import.meta.url).href;
  const script = `import { verifyShoppingArtifactAttestation } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(verifyShoppingArtifactAttestation("identity", JSON.parse(process.argv[1]))));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(artifact)], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "false");
});
