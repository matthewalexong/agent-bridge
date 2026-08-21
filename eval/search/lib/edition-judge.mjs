// edition-judge.mjs — deterministic judge for product-line / edition decoy errors.
//
// The failure it guards: the model cites a listing whose product LINE or
// EDITION differs from what the user asked for (e.g. user wants "Odyssey
// Homme Black" (the black-bottle cologne), model also cites "Odyssey Black
// Forest Dessert Edition"). Shared vocabulary ("Odyssey", "Black") does not
// make listings the same product.
//
// Input:
//   envelope   — the brain's JSON envelope ({citations, products_found, answer})
//   fixture    — the frozen SERP fixture the citations refer to (with .listings)
//   spec       — ground truth for the task:
//     { allowed_ids: [ids of listings of the SAME product the user asked about],
//       decoy_ids:  [ids that must NOT be cited or asserted],
//       decoy_names: [substring markers, e.g. "Black Forest"],  // title markers that
//                                                     // make a cited listing a decoy even if
//                                                     // the fixture id differs
//       must_cite_one_of: [ids]  // at least one correct listing must be cited
//     }
//
// Output: { pass, failures: [human-readable, per-violation] }
//
// Code judges correctness — never model self-report (standing RSI principle).

function listingsArray(fixture) {
  const ls = fixture?.listings?.listings ?? fixture?.listings;
  return Array.isArray(ls) ? ls : Object.values(ls || {});
}

export function judgeEditionDecoy(envelope, fixture, spec) {
  const failures = [];
  const listings = listingsArray(fixture);
  const byId = new Map(listings.map((l) => [l.id, l]));

  const citations = Array.isArray(envelope?.citations) ? envelope.citations : [];
  const citedIds = citations.map((c) => c.id).filter((id) => id != null);
  const products = Array.isArray(envelope?.products_found) ? envelope.products_found : [];
  const answer = envelope?.answer || "";

  const allowed = new Set(spec.allowed_ids || []);
  const decoySet = new Set(spec.decoy_ids || []);
  const markers = (spec.decoy_names || []).map((m) => m.toLowerCase());

  const citedTitles = new Map();
  for (const id of citedIds) {
    const l = byId.get(id);
    if (l) citedTitles.set(id, l.title || "");
  }

  // Rule 1: any cited listing whose id is a known decoy → FAIL.
  for (const id of citedIds) {
    if (decoySet.has(id)) {
      failures.push(`citation [id ${id}] is a decoy listing (${(byId.get(id)?.title || "").slice(0, 80)}) — not the product asked about`);
    }
  }

  // Rule 2: any cited listing whose TITLE carries a decoy name marker → FAIL
  // (catches re-captured fixtures whose ids shifted).
  for (const [id, title] of citedTitles) {
    const t = title.toLowerCase();
    for (const m of markers) {
      if (t.includes(m)) {
        failures.push(`citation [id ${id}] title "${title.slice(0, 80)}" matches decoy marker "${m}"`);
        break;
      }
    }
  }

  // Rule 3: products_found entries carrying a decoy marker → FAIL (the model
  // asserted the decoy exists as an answer to the user).
  for (const p of products) {
    const pl = String(p).toLowerCase();
    for (const m of markers) {
      if (pl.includes(m)) {
        failures.push(`products_found asserts decoy "${p}"`);
        break;
      }
    }
  }

  // Rule 4: the answer text presenting a decoy as a candidate/option → FAIL.
  // "mention as an aside" is still presenting it — the user asked about one
  // product; the reply must not offer a different edition as an option.
  const answerL = answer.toLowerCase();
  for (const m of markers) {
    if (answerL.includes(m)) {
      failures.push(`answer presents decoy "${m}" as a candidate (${answer.slice(0, 120)}…)`);
    }
  }

  // Rule 5: must cite at least one correct listing (else the reply is
  // unfounded, which fails the task for a different reason).
  if (spec.must_cite_one_of?.length) {
    const hit = citedIds.some((id) => allowed.has(id) || spec.must_cite_one_of.includes(id));
    if (!hit) failures.push("no citation of the correct product listing");
  }

  // Rule 6: cited listings outside the allowed set are suspect — flag them,
  // but only as a soft failure if they don't match decoy markers (could be a
  // legitimate size/variant of the right product the spec author missed).
  // Kept as a failure for now: strictness is the point of this round; the
  // spec's allowed_ids must enumerate every variant of the RIGHT product.
  for (const id of citedIds) {
    if (!allowed.has(id) && !decoySet.has(id)) {
      failures.push(`citation [id ${id}] is neither an allowed variant nor a known decoy (${(byId.get(id)?.title || "").slice(0, 80)}) — spec gap or relevance error`);
    }
  }

  return { pass: failures.length === 0, failures };
}
