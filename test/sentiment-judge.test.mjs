import test from "node:test";
import assert from "node:assert/strict";
import { judgeSentiment, aggregateCandidate, gradeTask } from "../eval/search/lib/sentiment-judge.mjs";

test("alias resolution: model answers with product name, not id", () => {
  const task = {
    expected: { query_type: "objective", verdict: "b" },
    candidates: [
      { id: "a", title: "Alpha Whey", reviews: [] },
      { id: "b", title: "IsoPure Ultra", reviews: [] },
    ],
  };
  const out = { query_type: "objective", verdict: "IsoPure Ultra", per_candidate: {} };
  const g = gradeTask(task, out);
  assert.equal(g.allOk, true, JSON.stringify(g.checks));
});

test("alias resolution is unambiguous-only: overlapping titles do not resolve", () => {
  const task = {
    expected: { query_type: "objective", verdict: "a" },
    candidates: [
      { id: "a", title: "IsoPure 2lb", reviews: [] },
      { id: "b", title: "IsoPure 5lb", reviews: [] },
    ],
  };
  // "IsoPure" matches both -> must NOT resolve; the bare word is a wrong answer here
  const out = { query_type: "objective", verdict: "IsoPure", per_candidate: {} };
  const g = gradeTask(task, out);
  assert.equal(g.allOk, false);
});

test("aggregateCandidate: any-positive wins", () => {
  assert.equal(aggregateCandidate(["none", "positive", "negative"]), "positive");
  assert.equal(aggregateCandidate(["negative", "none"]), "negative");
  assert.equal(aggregateCandidate(["none", "none"]), "none");
  assert.equal(aggregateCandidate(undefined), "none");
  assert.equal(aggregateCandidate([]), "none");
});

test("judgeSentiment: ties resolve to insufficient_evidence", () => {
  // 2 candidates, 1 positive each -> tie
  assert.equal(judgeSentiment({ a: ["positive"], b: ["positive"] }).verdict, "insufficient_evidence");
  // all none -> insufficient
  assert.equal(judgeSentiment({ a: ["none"], b: ["none"] }).verdict, "insufficient_evidence");
});

test("judgeSentiment: clear winner", () => {
  assert.equal(judgeSentiment({ a: ["positive", "positive"], b: ["negative"] }).verdict, "a");
});

test("judgeSentiment: negative-heavy vs none is still insufficient (no positive evidence)", () => {
  // a has negative, b has none. Neither has positive -> no basis to pick.
  assert.equal(judgeSentiment({ a: ["negative"], b: ["none"] }).verdict, "insufficient_evidence");
});

test("gradeTask: correct subjective pick scores 100", () => {
  const task = {
    expected: { query_type: "subjective", verdict: "a", classification: { a: "positive", b: "none" } },
  };
  const g = gradeTask(task, {
    query_type: "subjective",
    verdict: "a",
    per_candidate: { a: ["positive"], b: ["none"] },
    evidence: ["two years, zero tears"],
  });
  assert.equal(g.score, 100);
});

test("gradeTask: subjective pick without evidence scores 0", () => {
  const task = {
    expected: { query_type: "subjective", verdict: "a", classification: { a: "positive", b: "none" } },
  };
  const g = gradeTask(task, {
    query_type: "subjective",
    verdict: "a",
    per_candidate: { a: ["positive"], b: ["none"] },
    evidence: [],
  });
  assert.equal(g.score, 0);
});

test("gradeTask: honest insufficient_evidence with no relevant reviews scores 100", () => {
  const task = {
    expected: { query_type: "subjective", verdict: "insufficient_evidence", classification: { a: "none", b: "none" } },
  };
  const g = gradeTask(task, {
    query_type: "subjective",
    verdict: "insufficient_evidence",
    per_candidate: { a: ["none"], b: ["none"] },
    evidence: [],
  });
  assert.equal(g.score, 100);
});

test("gradeTask: wrong query_type scores 0 even if verdict is right", () => {
  const task = {
    expected: { query_type: "objective", verdict: "a" },
  };
  const g = gradeTask(task, {
    query_type: "subjective",
    verdict: "a",
    per_candidate: { a: ["positive"] },
    evidence: ["review text"],
  });
  assert.equal(g.score, 0);
});

test("gradeTask: objective over-routing to reviews scores 0", () => {
  const task = {
    expected: { query_type: "objective", verdict: "a" },
  };
  const g = gradeTask(task, {
    query_type: "objective",
    verdict: "a",
    per_candidate: {},
    evidence: ["cited a review"],
  });
  assert.equal(g.score, 0);
});

test("gradeTask: objective correct verdict with empty evidence scores 100", () => {
  const task = {
    expected: { query_type: "objective", verdict: "a" },
  };
  const g = gradeTask(task, {
    query_type: "objective",
    verdict: "a",
    per_candidate: {},
    evidence: [],
  });
  assert.equal(g.score, 100);
});

test("gradeTask: verdict inconsistent with own classifications scores 0", () => {
  const task = {
    expected: { query_type: "subjective", verdict: "a", classification: { a: "positive", b: "none" } },
  };
  const g = gradeTask(task, {
    query_type: "subjective",
    verdict: "a",
    per_candidate: { a: ["none"], b: ["positive"] },
    evidence: ["x"],
  });
  assert.equal(g.score, 0);
});
