// eval/lib/judge.mjs — the deterministic judgment layer. NO LLM involvement.
// Input: raw facts extracted by the model. Output: derived economics + the
// misleading_claim verdict + a templated explanation.
//
// Every rule here is inspectable, testable, and free to run. This is where
// "judgment" lives in the final architecture — not in any model.

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const near = (a, b, tol = 0.5) => a != null && b != null && Math.abs(a - b) <= tol;

// ---- Unit normalization (arithmetic lives HERE, not in the model) --------
// Gemma empirically cannot divide by 1000 even when explicitly told to
// (proven twice: cascade loop + manual replication, both with the instruction
// present). So the skill asks the model only to TRANSCRIBE the number and the
// unit as printed; this function performs the conversion deterministically.
//
// Two layers, in order:
//   1. EXPLICIT UNIT: if the model reports headline_protein_unit === "mg",
//      convert /1000. (The principled path — unit is read, not computed.)
//   2. PLAUSIBILITY FALLBACK: if no unit was reported and the raw headline is
//      >= 1000 AND at least 500x the per-scoop value, no protein supplement
//      delivers that in grams — treat as milligrams. Deliberately does NOT
//      fire for moderate deceptive claims (e.g. "1250G" at 62x per-scoop),
//      which must stay in grams so the misleading-claim rules can flag them.
// Known limitation: a hypothetical honest 500g+ per-serving claim would be
// misnormalized; no such product exists in the corpus or the market.
function normalizeHeadline(raw, unit, perScoop) {
  if (raw == null) return null;
  const u = String(unit ?? "").trim().toLowerCase();
  if (u === "mg") return raw / 1000;
  if (perScoop != null && raw >= 1000 && raw / perScoop >= 500) return raw / 1000;
  return raw;
}

export function judge(f) {
  const price = num(f.price_usd);
  const perScoop = num(f.protein_per_scoop_g);
  const headline = normalizeHeadline(num(f.headline_protein_g), f.headline_protein_unit, perScoop);
  const scoops = num(f.scoops_per_serving);
  const servings = num(f.servings_per_container);

  // Derived economics — pure arithmetic
  const totalProtein =
    perScoop != null && scoops != null && servings != null
      ? perScoop * scoops * servings
      : null;
  const costPerG =
    totalProtein && price != null ? +(price / totalProtein).toFixed(4) : null;

  // Misleading-claim verdict — the buyer's-reading rules
  let misleading = false;
  const reasons = [];
  if (headline != null && perScoop != null) {
    const perServing = scoops != null ? perScoop * scoops : null;
    if (near(headline, perScoop)) {
      // headline matches what ONE scoop delivers — honest
    } else if (scoops != null && scoops > 1 && near(headline, perServing)) {
      misleading = true;
      reasons.push(
        `Headline claims ${headline}g protein but one scoop delivers only ${perScoop}g — reaching the headline number requires ${scoops} scoops per serving, which the marketing does not disclose up front`
      );
    } else if (totalProtein != null && headline > totalProtein) {
      misleading = true;
      reasons.push(
        `Headline claims ${headline}g protein but the entire container holds only ${totalProtein}g of protein in total`
      );
    } else if (perServing != null && headline > perServing) {
      misleading = true;
      reasons.push(
        `Headline claims ${headline}g protein but one serving delivers only ${perServing}g`
      );
    }
  }

  return {
    headline_protein_g: headline, // normalized — overwrites the raw transcript in the scored answer
    total_protein_g: totalProtein,
    cost_per_g_protein_usd: costPerG,
    misleading_claim: misleading,
    explanation: reasons.length
      ? reasons.join(". ")
      : "Headline matches what one serving actually delivers.",
  };
}
