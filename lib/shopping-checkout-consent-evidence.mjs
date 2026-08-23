import { assessCheckoutConsent } from "./shopping-checkout-consent.mjs";
import { checkoutConsentInputFromTermsEvidence } from "./shopping-checkout-terms-evidence.mjs";
import { validateCheckoutPatternEvidence } from "./shopping-checkout-patterns.mjs";

export function checkoutConsentInputFromSignedEvidence(input) {
  const consentInput = checkoutConsentInputFromTermsEvidence(input);
  if (!validateCheckoutPatternEvidence(input.pattern_evidence, input.terms_evidence, input.evaluated_at, input.policy?.max_evidence_age_seconds ?? 120)) {
    throw Object.assign(new Error("Fresh exact process-attested checkout pattern evidence is required"), { code: "shopping_checkout_pattern_evidence_invalid" });
  }
  return {
    ...consentInput,
    urgency_claims: input.pattern_evidence.urgency_claims || [],
    checkout_pattern_attestation: input.pattern_evidence.artifact_attestation,
    checkout_pattern_blockers: input.pattern_evidence.blockers || [],
    checkout_pattern_warnings: input.pattern_evidence.warnings || [],
  };
}

export function assessCheckoutConsentFromEvidence(input) {
  return assessCheckoutConsent(checkoutConsentInputFromSignedEvidence(input));
}
