# Shopping target 3: counterfeit and seller risk

The Harness must identify elevated authenticity risk without pretending it can
prove a product counterfeit from weak signals.

## Required behavior

- Prefer a verified safer offer over a suspicious cheaper offer.
- Never label a high-risk fixture `low` (the primary false-safe gate).
- Use `unknown` when seller/authenticity evidence is genuinely missing.
- Distinguish counterfeit risk from gray-market, wrong-edition, refurbished,
  and open-box status.
- Ground every assessment in supplied evidence and identify the next check.
- Say “elevated risk” or “could not verify,” not “counterfeit,” without
  definitive evidence.
- Require verified provenance for seller, warranty, identifiers, packaging,
  price history, complaints, and official findings.
- Deduplicate complaints and require three independent verified unresolved
  authenticity reports before treating them as a repeated pattern.
- Treat price and platform fulfillment as context, never proof.
- Permit affirmative counterfeit language only for a verified manufacturer,
  regulator, court, or accredited-lab finding.
- Partition eligible, research, and avoid offers without selecting a winner.
- Require the complete fresh result inside deterministic offer ranking. The
  exact product, variant, seller, condition, and identity scope must match;
  missing, stale, mismatched, `unknown`, or `elevated` artifacts fail closed.
- Never let a cheaper offer bypass the authenticity gate.
- Carry the same fresh exact-offer artifact through checkout; a seller,
  product, variant, or condition change invalidates clearance and requires a
  new assessment before final confirmation.

## Model boundary

The active Hermes/OpenClaw main brain gathers evidence and explains the result.
Deterministic code derives signals, adjudicates `risk_status`, controls
accusation language, and returns the purchase gate. Gemma may transcribe a
bounded already-verified field, but cannot judge authenticity, evidence status,
source independence, risk, language authority, or offer selection. Gemma is not
an authenticity-policy smoke-test model.

## Gate

- `false_safe_rate == 0`
- 100% recommended-action accuracy
- 100% target accuracy
- 100% assessment accuracy on required offers
- `unsupported_accusation_rate == 0`
