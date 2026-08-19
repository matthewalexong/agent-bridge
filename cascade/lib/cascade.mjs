// Cascade: local-first recursive improvement loop.
//   1. local attempts (cheap, many) with verifier feedback folded back in
//   2. if local exhausted -> ONE frontier consult (reasoning + patch sketch)
//   3. local model APPLIES the frontier's guidance (local edits, verifier closes the loop)
// Everything deterministic-verifiable; frontier is a consultant, not a worker.
import { localCall, extractCodeBlock } from "./local-worker.mjs";
import { frontierCall } from "./frontier.mjs";

export async function cascade(task, verify, ledger, {
  localAttempts = 3,
  localRepairAttempts = 2,
  onEvent = () => {},
} = {}) {
  const messages = [
    { role: "system", content: task.system || "You are an expert engineer. Output exactly one ```js code block. No prose outside it." },
    { role: "user", content: task.prompt },
  ];

  // Dev escape hatch: skip straight to the frontier consult (iterating on the escalation path).
  const skipLocal = process.env.CASCADE_SKIP_LOCAL === "1";
  // ---- Phase 1: local attempts with feedback ----
  for (let attempt = 1; attempt <= (skipLocal ? 0 : localAttempts); attempt++) {
    const res = await localCall(messages, { maxTokens: task.maxTokens || 2000 });
    ledger.record({ phase: `local-try-${attempt}`, task: task.id, ...res });
    onEvent({ phase: "local-try", attempt, tokens: res.completionTokens, ms: res.ms });

    const code = extractCodeBlock(res.text);
    if (!code) {
      messages.push({ role: "assistant", content: res.text });
      messages.push({ role: "user", content: "You output no ```js code block. Try again with exactly one." });
      continue;
    }
    const verdict = await verify(code);
    onEvent({ phase: "verify", attempt, pass: verdict.pass });
    if (verdict.pass) {
      return { status: "local-solved", code, attempts: attempt, report: verdict.report };
    }
    // feedback mutation: fold the EXACT verifier output into the next attempt
    messages.push({ role: "assistant", content: res.text });
    messages.push({ role: "user", content: task.feedbackPrefix ? task.feedbackPrefix(verdict.report) : `FAILED verification. Verifier output:\n${verdict.report}\n\nFix it. Output the corrected code block.` });
  }

  // ---- Phase 2: frontier consult ----
  // The gateway caps frontier output at ~8K tokens, so instead of asking for full code
  // (which gets truncated mid-function), we ask for a COMPACT diagnosis + algorithm,
  // then have the LOCAL model implement it. Consultant thinks, worker types.
  onEvent({ phase: "escalate" });
  const lastFeedback = messages.length > 2 ? messages[messages.length - 1].content : null;
  const consultMessages = [
    { role: "system", content: "You are a principal engineer giving a CONSULTATION, not writing the full solution. In UNDER 1500 words: (1) diagnose precisely why the junior's approach fails — cite the exact arithmetic/logic bug; (2) state the correct algorithm as numbered steps or a compact formula; (3) list the edge cases that must be handled. Do NOT write the complete implementation — the junior will code it from your diagnosis." },
    { role: "user", content: task.prompt + (lastFeedback ? `\n\nThe junior engineer's best attempt failed verification. Verifier output:\n${lastFeedback}` : "") },
  ];
  // Reasoning-model frontier (e.g. qwen3.8-max): the model spends tokens on
  // internal thinking BEFORE emitting the consultation text. A 3000 cap got
  // fully burned on thinking, returning empty text (Round 3 failure). 8000
  // leaves room to finish reasoning AND deliver the diagnosis.
  const f = await frontierCall(consultMessages, { maxTokens: Math.min(task.frontierMaxTokens || 8000, 8000) });
  ledger.record({ phase: "frontier-consult", task: task.id, ...f });
  onEvent({ phase: "frontier", tokens: f.promptTokens + f.completionTokens, ms: f.ms });

  // If the frontier happened to include a full code block, verify it directly first.
  const frontierCode = extractCodeBlock(f.text);
  if (frontierCode && frontierCode.trim().length > 50) {
    const verdict = await verify(frontierCode);
    onEvent({ phase: "verify-frontier", pass: verdict.pass });
    if (verdict.pass) {
      return { status: "frontier-solved", code: frontierCode, report: verdict.report, frontierTokens: f.promptTokens + f.completionTokens };
    }
  }

  // ---- Phase 3: local IMPLEMENTS the frontier's diagnosis (the token-frugal path) ----
  const implMessages = [
    { role: "system", content: task.system || "You are an expert engineer. Output exactly one ```js code block. No prose outside it." },
    { role: "user", content: `${task.prompt}\n\nA principal engineer reviewed this task and provided the following diagnosis and algorithm — implement it EXACTLY:\n\n${f.text}` },
  ];
  for (let r = 1; r <= localRepairAttempts; r++) {
    const res = await localCall(implMessages, { maxTokens: task.maxTokens || 2000 });
    ledger.record({ phase: `local-implement-${r}`, task: task.id, ...res });
    onEvent({ phase: "local-implement", repair: r, tokens: res.completionTokens, ms: res.ms });
    const code = extractCodeBlock(res.text);
    if (!code) continue;
    const v2 = await verify(code);
    onEvent({ phase: "verify-repair", repair: r, pass: v2.pass });
    if (v2.pass) {
      return { status: "frontier-guided-local", code, report: v2.report, frontierTokens: f.promptTokens + f.completionTokens };
    }
    implMessages.push({ role: "assistant", content: res.text });
    implMessages.push({ role: "user", content: `Still failing verification:\n${v2.report}\nRe-read the diagnosis above and fix the implementation.` });
  }
  return { status: "unresolved", report: "all tiers exhausted", frontierTokens: f.promptTokens + f.completionTokens };
}
