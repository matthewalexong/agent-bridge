import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = path.join(root, "eval/search/live/hermes-brain.mjs");

// Run hermes-brain against a config file we control (HERMES_BRAIN_CONFIG_FILE),
// pointed at a local mock endpoint. Returns {code, stdout, stderr}.
function runBrain(cfgPath, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRAIN], {
      // Unit tests must never publish progress into the user's live extension.
      // Point bridge discovery at this test's isolated temporary directory;
      // explicit scenario overrides (such as the full-loop E2E) still win.
      env: { ...process.env, HERMES_BRAIN_CONFIG_FILE: cfgPath, CHROME_AGENT_BRIDGE_DIR: path.dirname(cfgPath), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end(); // EOF required — the execFile+input hang this replaces
  });
}

test("hermes-brain executes a bounded parallel evidence batch in one model turn", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-batch-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const text = requests.length === 1
        ? 'SEARCH_BATCH: [{"lane":"product_evidence","query":"camera x tests"},{"lane":"safety","query":"camera x recalls"}]'
        : '```json\n{"correction_detected":false,"prior_claim":null,"searches":[],"products_found":[],"citations":[],"answer":"Parallel evidence complete."}\n```';
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const fixture = path.join(root, "eval/search/live/captures/extract-2026-08-21T16-02-38-384Z.json");
  const result = await runBrain(cfgPath, "compare camera x", { AB_FIXTURE: fixture, AB_EMIT_ENVELOPE: "1" });
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.answer, "Parallel evidence complete.");
  assert.equal(envelope.searches.length, 2);
  assert.deepEqual(envelope.searches.map((item) => item.lanes[0]), ["product_evidence", "safety"]);
  const secondPrompt = JSON.stringify(requests[1]);
  assert.match(secondPrompt, /SEARCH BATCH RESULTS/);
  assert.match(secondPrompt, /LANES: product_evidence/);
  assert.match(secondPrompt, /LANES: safety/);
});

function writeConfig(dir, baseUrl) {
  const cfgPath = path.join(dir, "config.yaml");
  const yaml = [
    "model:",
    "  provider: mock",
    `  base_url: ${baseUrl}`,
    "  api_key: test-key",
    "  default: mock-model",
    "  api_mode: anthropic_messages",
    "",
  ].join("\n");
  return fs.writeFile(cfgPath, yaml).then(() => cfgPath);
}

test("hermes-brain falls back to the Hermes CLI for credential-pool configs", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-cli-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, "config.yaml");
  await fs.writeFile(cfgPath, ["model:", "  provider: xai", "  default: grok-4.6", "  base_url: https://api.x.ai/v1", ""].join("\n"));
  const cliPath = path.join(dir, "hermes-stub.mjs");
  await fs.writeFile(cliPath, "#!/usr/bin/env node\nconst args=process.argv.slice(2); if(!args.includes('--oneshot')||!args.includes('--provider')||!args.includes('--model')) process.exit(9); process.stdout.write('credential-pool relay works');\n");
  await fs.chmod(cliPath, 0o700);
  const previous = process.env.HERMES_BRAIN_CLI;
  process.env.HERMES_BRAIN_CLI = cliPath;
  context.after(() => { if (previous == null) delete process.env.HERMES_BRAIN_CLI; else process.env.HERMES_BRAIN_CLI = previous; });
  const result = await runBrain(cfgPath, "test credential pool relay");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "credential-pool relay works");
});

// Regression for the real panel failure: the endpoint returned only a
// "thinking" block (budget exhausted), so the brain produced no text. The
// brain must fail LOUDLY with a diagnostic naming the block types — never
// silently post nothing, never hang.
test("hermes-brain: thinking-only response fails loudly with diagnostics", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      content: [{ type: "thinking", thinking: "..." }],
      stop_reason: "max_tokens",
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  context.after(() => server.close());

  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const { code, stdout, stderr } = await runBrain(cfgPath, "what's the cheapest protein powder?");

  assert.equal(code, 1, "brain must exit non-zero on no-text response");
  assert.equal(stdout, "", "brain must not emit an empty reply");
  assert.match(stderr, /model returned no text/);
  assert.match(stderr, /thinking/, "diagnostic must name the block types actually returned");
});

// Happy path against the mock: text block comes back → brain prints it, exit 0.
test("hermes-brain: text block is emitted on stdout with exit 0", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "NOW Foods Isolate at $0.044/g protein." },
        ],
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  context.after(() => server.close());

  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const { code, stdout } = await runBrain(cfgPath, "cheapest protein?");

  assert.equal(code, 0);
  assert.equal(stdout, "NOW Foods Isolate at $0.044/g protein.");
});

// Endpoints that reject the thinking param (400) must trigger the bare retry.
test("hermes-brain: retries without thinking param on 400", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));

  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      if ("thinking" in parsed) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "thinking not supported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  context.after(() => server.close());

  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const { code, stdout } = await runBrain(cfgPath, "hi");

  assert.equal(code, 0);
  assert.equal(stdout, "ok");
  assert.equal(seen.length, 2, "expected initial request + bare retry");
  assert.ok("thinking" in seen[0], "first request carried thinking");
  assert.ok(!("thinking" in seen[1]), "retry must drop thinking");
});
