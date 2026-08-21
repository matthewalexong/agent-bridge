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
function runBrain(cfgPath, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRAIN], {
      env: { ...process.env, HERMES_BRAIN_CONFIG_FILE: cfgPath },
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
