import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("contributor onboarding preserves the harness-neutral architecture", async () => {
  const [contributing, architecture, adapters, support, readme] = await Promise.all([
    read("CONTRIBUTING.md"),
    read("docs/architecture.md"),
    read("docs/harness-session-adapters.md"),
    read("SUPPORT.md"),
    read("README.md"),
  ]);

  assert.match(contributing, /harness owns the main reasoning model/i);
  assert.match(contributing, /optional optimizations rather than architectural dependencies/i);
  assert.match(architecture, /The harness is the main brain\./);
  assert.match(architecture, /Shopping is the first mature example\./);
  assert.match(architecture, /snapshot → one atomic action → new snapshot/);
  assert.match(adapters, /Main reasoning model, planning, and tool choices \| Connected harness/);
  assert.match(adapters, /Private reasoning, tool requests, tool responses/);
  assert.match(adapters, /New session is genuine/);
  assert.match(support, /response-quality form/i);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /docs\/architecture\.md/);
});

test("public collaboration forms protect private browser state", async () => {
  const paths = [
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/response_quality.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ];
  const contents = await Promise.all(paths.map(read));

  assert.match(contents[0], /security\/advisories\/new/);
  assert.match(contents[1], /pairing tokens, cookies, headers, bodies, private URLs/i);
  assert.match(contents[2], /neutral bridge, a harness adapter, or a domain capability/i);
  assert.match(contents[3], /General web research/);
  assert.match(contents[3], /Shopping or product comparison/);
  assert.match(contents[4], /npm run audit:public/);
  for (const content of contents) assert.doesNotMatch(content, /CHROME_AGENT_BRIDGE_TOKEN\s*[:=]\s*[^\s"']+/);
});

test("new contributor documents contain no broken local Markdown links", async () => {
  const paths = ["README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SUPPORT.md", "docs/architecture.md", "docs/harness-session-adapters.md", "docs/public-beta.md", "docs/quick-start.md"];
  for (const path of paths) {
    const content = await read(path);
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const file = target.split("#", 1)[0];
      await assert.doesNotReject(access(resolve(root, dirname(path), file)), `${path} links to missing ${target}`);
    }
  }
});

test("public beta release is gated and publishes a checksum", async () => {
  const workflow = await read(".github/workflows/release.yml");
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);

  assert.match(workflow, /^permissions:\n\s+contents: read$/m);
  assert.match(workflow, /^\s+contents: write$/m);
  assert.match(workflow, /check-release-version\.mjs/);
  assert.match(workflow, /npm run audit:public/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /--notes-file docs\/public-beta\.md/);
  assert.ok(actions.length >= 2);
  for (const action of actions) assert.match(action, /^[^@]+@[a-f0-9]{40}$/);
});
