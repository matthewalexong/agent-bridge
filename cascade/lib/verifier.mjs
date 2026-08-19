// Verifier: writes candidate code to a sandbox dir and EXECUTES deterministic checks.
// Ground truth is the test run, not any model's opinion.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

export function makeVerifier(testScriptBody, { timeoutMs = 60000 } = {}) {
  return async function verify(code) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-verify-"));
    const candidatePath = path.join(dir, "candidate.mjs");
    const testPath = path.join(dir, "verify.mjs");
    try {
      fs.writeFileSync(candidatePath, code);
      // 1) syntax gate
      try {
        execSync(`node --check ${candidatePath}`, { encoding: "utf8", timeout: 15000 });
      } catch (e) {
        return { pass: false, report: `SYNTAX ERROR:\n${(e.stderr || e.stdout || e.message).slice(0, 900)}` };
      }
      // 2) behavioral gate — the task supplies the assertions
      fs.writeFileSync(testPath, `import * as candidate from ${JSON.stringify(candidatePath)};\n${testScriptBody}`);
      try {
        const out = execSync(`node ${testPath}`, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 });
        return { pass: true, report: out.trim() };
      } catch (e) {
        const msg = (e.stderr || "") + (e.stdout || "") || String(e.message);
        return { pass: false, report: `BEHAVIORAL FAILURE:\n${msg.slice(0, 1200)}` };
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
