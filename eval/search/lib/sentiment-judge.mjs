// eval/search/lib/sentiment-judge.mjs — deterministic grading layer for
// subjective-attribute queries ("most durable", "most comfortable").
//
// Split of responsibilities (this is the RSI architecture):
//   MODEL reasons about:  (a) is this query subjective -> route to reviews?
//                         (b) classify each review for the requested attribute.
//   CODE (this file):     turns classifications into a verdict, and grades
//                         routing + verdict + classification against ground
//                         truth stored in the task JSON. NO LLM here.

export function aggregateCandidate(classification) {
  if (!Array.isArray(classification) || classification.length === 0) return "none";
  if (classification.includes("positive")) return "positive";
  if (classification.includes("negative")) return "negative";
  return "none";
}

export function judgeSentiment(perCandidate) {
  const ids = Object.keys(perCandidate);
  if (ids.length === 0) return { verdict: "insufficient_evidence", scores: {} };
  const scores = {};
  for (const id of ids) {
    let s = 0;
    for (const c of perCandidate[id] || []) {
      if (c === "positive") s += 1;
      else if (c === "negative") s -= 1;
    }
    scores[id] = s;
  }
  const max = Math.max(...Object.values(scores));
  if (max <= 0) return { verdict: "insufficient_evidence", scores };
  const winners = ids.filter((id) => scores[id] === max);
  if (winners.length === 1) return { verdict: winners[0], scores };
  return { verdict: "insufficient_evidence", scores };
}

function resolveVerdictAlias(task, verdict) {
  // Production answers name products ("IsoPure Ultra"), not harness ids ("b").
  // Deterministically resolve an unambiguous title reference to its id so the
  // grade reflects semantics, not id-literalism. Returns the resolved id, or
  // the original string when no unambiguous match exists.
  //
  // GUARD 1: if the verdict is already a valid candidate id, return it AS-IS.
  // Without this, a single-letter id like "a" substring-matches unrelated
  // titles ("softhands" contains "a") and flips a correct answer.
  // GUARD 2: only treat verdicts of >=3 chars as possible title aliases, so
  // stray single letters can never enter title matching.
  if (typeof verdict !== "string" || !verdict.trim()) return verdict;
  const v = verdict.trim().toLowerCase();
  const ids = (task.candidates || []).map((c) => String(c.id).toLowerCase());
  if (ids.includes(v)) return v;
  if (v.length < 3) return verdict;
  const matches = (task.candidates || []).filter((c) => {
    const t = (c.title || "").toLowerCase();
    return t.includes(v) || v.includes(t);
  });
  return matches.length === 1 ? matches[0].id : verdict;
}

export function gradeTask(task, modelOutput) {
  const out = modelOutput || {};
  const checks = [];

  // 1) Routing: did the model correctly identify objective vs subjective?
  const expectedType = task.expected.query_type || "subjective";
  const gotType = out.query_type;
  checks.push({ field: "query_type", expected: expectedType, got: gotType, ok: gotType === expectedType });

  // 2) Verdict — checked against the model's OWN stated verdict.
  const perCandidate = out.per_candidate || {};
  const expectedVerdict = task.expected.verdict;
  const resolvedVerdict = resolveVerdictAlias(task, out.verdict);
  checks.push({ field: "verdict", expected: expectedVerdict, got: resolvedVerdict, ok: resolvedVerdict === expectedVerdict });

  // 3) For subjective tasks: classification must be consistent AND support the verdict.
  if (expectedType === "subjective") {
    const expClass = task.expected.classification || {};
    for (const [id, expected] of Object.entries(expClass)) {
      const got = aggregateCandidate(perCandidate[id]);
      checks.push({ field: `class:${id}`, expected, got, ok: got === expected });
    }
    if (expectedVerdict !== "insufficient_evidence") {
      // The classifications must actually point at the picked candidate.
      const { verdict: derivedVerdict } = judgeSentiment(perCandidate);
      checks.push({ field: "verdict_consistency", expected: expectedVerdict, got: derivedVerdict, ok: derivedVerdict === expectedVerdict });
      // Subjective picks must cite evidence.
      const hasEvidence = Array.isArray(out.evidence) && out.evidence.length > 0;
      checks.push({ field: "evidence_present", expected: true, got: hasEvidence, ok: hasEvidence });
    }
  } else {
    // Objective control: must NOT over-route to reviews.
    const overRouted = Array.isArray(out.evidence) && out.evidence.length > 0;
    checks.push({ field: "no_review_overroute", expected: false, got: overRouted, ok: !overRouted });
  }

  const allOk = checks.every((c) => c.ok);
  return { score: allOk ? 100 : 0, checks, allOk };
}
