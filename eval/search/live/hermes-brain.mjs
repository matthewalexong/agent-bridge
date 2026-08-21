#!/usr/bin/env node
// hermes-brain.mjs — panel reply brain v2: transcript-aware + search tool loop.
//
// Contract (matches panel-watcher --handler-cmd):
//   stdin  = user message text
//   stdout = reply text (live) OR JSON envelope (AB_EMIT_ENVELOPE=1)
//   env AB_TRANSCRIPT_JSON = JSON array of {role, text} prior messages
//   env AB_SKILL_FILE      = path to skill markdown (RSI target)
//   env AB_FIXTURE         = fixture file for search backend (eval mode)
//   env AB_SEARCH_BACKEND  = "live" for real SERP (final verification only)
//   env AB_EMIT_ENVELOPE   = "1" to emit full JSON envelope on stdout
//   exit 0 = success; non-zero = failure
//
// The brain runs a bounded tool loop:
//   1. Assemble prompt: skill + transcript + current message
//   2. Ask model → parse response
//   3. If model requests SEARCH → execute, append results, re-ask (max 4)
//   4. If model emits JSON envelope → done
//
// The skill file is the RSI mutation target. The loop never touches the brain
// code itself — only the skill text changes between attempts.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "./model-client.mjs";
import { makeSearchBackend } from "./search-backend.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_SEARCH_TURNS = 4;

function loadSkill() {
  const path = process.env.AB_SKILL_FILE
    || join(__dirname, "../skills/panel-chat-skill-v2.md");
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseTranscript() {
  const raw = process.env.AB_TRANSCRIPT_JSON || "[]";
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Parse model response: either a SEARCH directive or a JSON envelope.
function parseModelResponse(text) {
  // Check for SEARCH: directive (case-insensitive, may have surrounding text)
  const searchMatch = text.match(/^\s*SEARCH:\s*(.+)$/im);
  if (searchMatch) {
    return { type: "search", query: searchMatch[1].trim() };
  }
  // Try to extract JSON envelope
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : (text.match(/\{[\s\S]*\}/) || [null])[0];
  if (candidate) {
    try {
      const env = JSON.parse(candidate);
      if (env.answer !== undefined) return { type: "envelope", envelope: env, raw: text };
    } catch { /* not valid JSON */ }
  }
  // No structured output — treat as plain answer
  return { type: "plain", text: text.trim() };
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) { console.error("hermes-brain: empty message"); process.exit(1); }

  const skill = loadSkill();
  const transcript = parseTranscript();
  const searches = []; // log of {query, results}

  // Build search backend
  const backendOpts = {};
  if (process.env.AB_FIXTURE) backendOpts.fixture = process.env.AB_FIXTURE;
  if (process.env.AB_SEARCH_BACKEND === "live") backendOpts.live = true;
  let search;
  try {
    search = makeSearchBackend(backendOpts);
  } catch (e) {
    // No fixture and not live — no search available; brain answers from skill alone
    search = null;
  }

  // System prompt: skill + tool protocol
  const system = [
    skill || "You are a helpful shopping assistant.",
    "",
    "## OUTPUT PROTOCOL",
    "You have a search tool. To use it, reply with EXACTLY:",
    "SEARCH: <your query>",
    "The system will return search results, then you reply again.",
    "When you have enough information (or don't need to search), reply with a JSON envelope:",
    "```json",
    JSON.stringify({
      correction_detected: false,
      prior_claim: null,
      searches: [],
      products_found: [],
      citations: [],
      answer: "your reply to the user",
    }, null, 1),
    "```",
    "Rules for the envelope:",
    "- correction_detected: true ONLY if the user's message contradicts/corrects something you previously said",
    "- prior_claim: if correction detected, quote what you previously got wrong (else null)",
    "- searches: array of {query} for every search you performed",
    "- products_found: array of product names you are asserting exist",
    "- citations: array of {id, price_usd} for listings you reference (id = the [id N] from search results)",
    "- answer: your final user-facing reply (plain text, concise)",
    "",
    "CRITICAL: Never answer product questions from memory. Always search first.",
    "If the user corrects you, acknowledge the error, then re-search for the right answer.",
  ].join("\n");

  // Build message history from transcript
  const messages = [];
  for (const msg of transcript) {
    if (msg.role === "user") messages.push({ role: "user", content: msg.text });
    else messages.push({ role: "assistant", content: msg.text });
  }
  messages.push({ role: "user", content: text });

  // Tool loop
  let envelope = null;
  for (let turn = 0; turn <= MAX_SEARCH_TURNS; turn++) {
    let reply;
    try {
      reply = await ask(messages, { system, maxTokens: 4096 });
    } catch (e) {
      console.error(`hermes-brain: model error on turn ${turn}: ${e.message}`);
      process.exit(1);
    }

    const parsed = parseModelResponse(reply);

    if (parsed.type === "search") {
      if (!search) {
        // No backend — tell model search is unavailable
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: "SEARCH UNAVAILABLE — no search backend configured. Answer with what you have, or say you cannot verify." });
        continue;
      }
      searches.push({ query: parsed.query });
      let results;
      try {
        results = await search(parsed.query);
      } catch (e) {
        results = `SEARCH ERROR: ${e.message}`;
      }
      messages.push({ role: "assistant", content: reply });
      messages.push({ role: "user", content: `SEARCH RESULTS:\n${results}\n\nNow respond with your final JSON envelope (or another SEARCH: if you need different results).` });
      continue;
    }

    if (parsed.type === "envelope") {
      envelope = parsed.envelope;
      // Backfill searches log if model omitted them
      if (!Array.isArray(envelope.searches) || envelope.searches.length === 0) {
        envelope.searches = searches;
      }
      break;
    }

    // Plain text — wrap in envelope
    envelope = {
      correction_detected: false,
      prior_claim: null,
      searches,
      products_found: [],
      citations: [],
      answer: parsed.text,
    };
    break;
  }

  if (!envelope) {
    // Exhausted search turns without a final answer
    envelope = {
      correction_detected: false,
      prior_claim: null,
      searches,
      products_found: [],
      citations: [],
      answer: "I searched but couldn't complete the answer. Please try rephrasing.",
    };
  }

  if (process.env.AB_EMIT_ENVELOPE === "1") {
    process.stdout.write(JSON.stringify(envelope));
  } else {
    process.stdout.write(envelope.answer || "");
  }
}

main().catch((e) => { console.error(`hermes-brain: ${e.message}`); process.exit(1); });
