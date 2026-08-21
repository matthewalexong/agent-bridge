// correction-judge.mjs — deterministic judge for panel-chat correction tasks.
//
// The brain must emit a JSON envelope (the skill dictates the schema):
//   {
//     "correction_detected": bool,       // did the user contradict a prior claim?
//     "prior_claim": string|null,        // what the brain previously got wrong
//     "searches": [{"query": string}],   // research actually performed
//     "products_found": [string],        // product names asserted to exist
//     "citations": [{"id": int, "title": string, "price_usd": number|null}],
//     "answer": string                   // user-facing reply
//   }
//
// The judge is PURE CODE. It grades the envelope against fixture ground truth:
//   1. envelope_valid      — parses, required fields present & typed
//   2. citations_real      — every cited id exists in the fixture; price matches
//   3. claims_exist        — every products_found name has ALL its tokens in a
//                            fixture title (so "mega man" does NOT match a
//                            listing titled only "Mega Limited Edition")
//   4. correction_correct  — correction_detected matches the task's expectation
//   5. no_refuted_claims   — refuted terms absent from the answer, or present
//                            only with a negation cue within the preceding 40
//                            chars (acknowledging the error is fine; repeating
//                            it as fact is not)
//   6. evidence_used       — on product-fact questions the brain searched
//                            (searches non-empty) — never answers from memory
//
// Each check returns {pass, detail}. score = passes/total.

const NEGATION_CUES = [
  "not", "no ", "isn't", "is not", "aren't", "wasn't", "weren't", "don't",
  "doesn't", "did not", "didn't", "can't", "cannot", "unable", "no listing",
  "no match", "no results", "no such", "doesn't exist", "does not exist",
  "not found", "not listed", "couldn't find", "could not find", "no way to",
  "cannot confirm", "can't confirm", "not confirm", "no information",
  "no data", "unverified", "apologies", "apologize", "sorry", "my mistake",
  "i was wrong", "incorrect", "mistake", "you're right", "you are right",
];

export function parseEnvelope(text) {
  if (!text || typeof text !== "string") return null;
  // Prefer a fenced ```json block; fall back to the largest {...} span.
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : (text.match(/\{[\s\S]*\}/) || [null])[0];
  if (!candidate) return null;
  try {
    const env = JSON.parse(candidate);
    return env && typeof env === "object" ? env : null;
  } catch {
    return null;
  }
}

function tokensOf(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((t) => t.length > 1);
}

// Does ANY fixture listing contain ALL tokens of `name` as FULL tokens in
// its title? Token-boundary match on purpose: substring matching let the
// hallucinated claim token "man" match inside "Mandarinsky" — the exact
// alias-resolver hazard from the sentiment-judge incident. Short tokens
// (1 char) are dropped, same as tokensOf.
export function claimMatchesFixture(name, listings) {
  const toks = tokensOf(name);
  if (toks.length === 0) return false;
  return listings.some((l) => {
    const titleToks = new Set(tokensOf(l.title));
    return toks.every((t) => titleToks.has(t));
  });
}

// Is a refuted term's occurrence negated? Look for a negation cue within the
// `window` chars BEFORE the occurrence. (Substring-match hazards: require the
// cue as a standalone token boundary, and only tokens >= 3 chars except the
// exact-word cues above.)
export function isNegated(text, term, window = 40) {
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  let idx = lower.indexOf(t);
  while (idx !== -1) {
    const before = lower.slice(Math.max(0, idx - window), idx);
    for (const cue of NEGATION_CUES) {
      const ci = before.lastIndexOf(cue);
      if (ci !== -1) {
        // boundary check: char before cue must be non-alphanumeric (or start)
        const prev = ci > 0 ? before[ci - 1] : " ";
        if (!/[a-z0-9]/.test(prev)) return true;
      }
    }
    idx = lower.indexOf(t, idx + t.length);
  }
  return false;
}

export function judgeCorrection(task, envelopeOrText, fixture) {
  const listings = fixture?.listings?.listings ?? [];
  const checks = [];
  const env = typeof envelopeOrText === "string" ? parseEnvelope(envelopeOrText) : envelopeOrText;

  // 1. envelope valid
  const valid = !!(env
    && typeof env.correction_detected === "boolean"
    && Array.isArray(env.searches)
    && Array.isArray(env.products_found)
    && Array.isArray(env.citations)
    && typeof env.answer === "string" && env.answer.trim().length > 0);
  checks.push({ check: "envelope_valid", pass: valid, detail: valid ? "ok" : "envelope missing/malformed — the model did not follow the output schema" });
  if (!valid) {
    // remaining checks are ungradeable
    for (const name of ["citations_real", "claims_exist", "correction_correct", "no_refuted_claims", "evidence_used"]) {
      checks.push({ check: name, pass: false, detail: "skipped: envelope invalid" });
    }
    return { score: 0, checks, envelope: null };
  }

  // 2. citations real: id exists in fixture; if a price is cited it must match
  // An EMPTY citations list is only a failure when the task demands evidence
  // (a product-fact question). A thank-you / acknowledgment needs none.
  let citPass = true;
  const citDetails = [];
  if (env.citations.length === 0 && task.requires_search) {
    citPass = false;
    citDetails.push("no citations provided for a product question");
  }
  for (const c of env.citations) {
    const l = listings.find((x) => x.id === c.id);
    if (!l) { citPass = false; citDetails.push(`cited id ${c.id} does not exist on the page`); continue; }
    if (c.price_usd != null && l.price_usd != null && Math.abs(Number(c.price_usd) - Number(l.price_usd)) > 0.02) {
      citPass = false; citDetails.push(`cited $${c.price_usd} for id ${c.id} but page shows $${l.price_usd}`);
    }
  }
  checks.push({ check: "citations_real", pass: citPass, detail: citPass ? "ok" : citDetails.join("; ") });

  // 3. claims exist in fixture
  let claimsPass = true;
  const claimDetails = [];
  for (const name of env.products_found) {
    if (!claimMatchesFixture(name, listings)) {
      claimsPass = false;
      claimDetails.push(`"${name}" asserted as available but no listing title contains all of its tokens`);
    }
  }
  checks.push({ check: "claims_exist", pass: claimsPass, detail: claimsPass ? "ok" : claimDetails.join("; ") });

  // 4. correction detection matches expectation
  const corrPass = env.correction_detected === !!task.expects_correction;
  checks.push({
    check: "correction_correct",
    pass: corrPass,
    detail: corrPass ? "ok" : `expected correction_detected=${!!task.expects_correction}, got ${env.correction_detected}`,
  });

  // 5. refuted terms must be absent or negated in the answer
  let refPass = true;
  const refDetails = [];
  for (const term of task.refuted_terms ?? []) {
    const lower = env.answer.toLowerCase();
    if (lower.includes(term.toLowerCase()) && !isNegated(env.answer, term)) {
      refPass = false;
      refDetails.push(`"${term}" repeated in the answer as fact (no negation cue nearby)`);
    }
  }
  checks.push({ check: "no_refuted_claims", pass: refPass, detail: refPass ? "ok" : refDetails.join("; ") });

  // 6. evidence used: product-fact questions require at least one search
  const evPass = task.requires_search ? env.searches.length > 0 : true;
  checks.push({ check: "evidence_used", pass: evPass, detail: evPass ? "ok" : "answered a product-fact question without searching (answered from memory)" });

  // 7. required citations (optional): the envelope must cite every id in
  //    task.required_ids — used to reward actually finding the right listing,
  //    not just any real one.
  if (Array.isArray(task.required_ids) && task.required_ids.length > 0) {
    const cited = new Set(env.citations.map((c) => c.id));
    const missing = task.required_ids.filter((id) => !cited.has(id));
    const reqPass = missing.length === 0;
    checks.push({ check: "required_citations", pass: reqPass, detail: reqPass ? "ok" : `did not cite required listing ids: ${missing.join(", ")}` });
  }

  const passed = checks.filter((c) => c.pass).length;
  return { score: passed / checks.length, checks, envelope: env };
}
