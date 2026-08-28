import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { auditGitHistory, auditTrackedFiles, scanText } from "../scripts/audit-public-repo.mjs";

test("public repository audit detects credentials without returning their values", () => {
  const token = ["xai", "A".repeat(32)].join("-");
  const findings = scanText("unsafe.txt", `token=${token}`);
  assert.deepEqual(findings, [{ file: "unsafe.txt", line: 1, rule: "xAI API token" }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test("public repository audit detects private local paths and forbidden files", () => {
  const privatePath = ["", "Users", "private-name", "project", "result.json"].join("/");
  const pathFindings = scanText("result.json", JSON.stringify({ path: privatePath }));
  assert.equal(pathFindings[0].rule, "developer-specific absolute home path");

  const fileFindings = auditTrackedFiles({
    listFiles: [".env", "safe.txt"],
    readFile: () => Buffer.from("placeholder"),
  });
  assert.equal(fileFindings.some((finding) => finding.file === ".env" && finding.rule.includes("forbidden")), true);
});

test("public repository audit reports history matches without exposing content", () => {
  const commit = "a".repeat(40);
  const findings = auditGitHistory({
    commits: [commit],
    grepCommit: () => [`${commit}:old-config.txt`],
    listCommitFiles: () => ["safe.txt", "credentials/auth.json"],
  });
  assert.deepEqual(findings, [
    { file: "old-config.txt", line: 1, rule: `credential-shaped content in Git history (${"a".repeat(12)})` },
    { file: "credentials/auth.json", line: 1, rule: `forbidden credential file in Git history (${"a".repeat(12)})` },
  ]);
  assert.equal(JSON.stringify(findings).includes("secret value"), false);
});

test("security workflow preserves full-history, least-privilege checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/security.yml", import.meta.url), "utf8");
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);

  assert.match(workflow, /^permissions:\n\s+contents: read$/m);
  assert.match(workflow, /^\s+persist-credentials: false$/m);
  assert.match(workflow, /^\s+fetch-depth: 0$/m);
  assert.ok(actions.length >= 2);
  for (const action of actions) assert.match(action, /^[^@]+@[a-f0-9]{40}$/);
  assert.match(workflow, /^\s+run: npm run audit:public$/m);
  assert.match(workflow, /^\s+run: npm audit --omit=dev --audit-level=high$/m);
  assert.match(workflow, /^\s+run: npm run check$/m);
});
