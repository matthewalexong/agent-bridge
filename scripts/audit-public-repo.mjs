#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const credentialRules = [
  ["xAI API token", /xai-[A-Za-z0-9_-]{20,}/g],
  ["Qwen API token", /sk-sp-[A-Za-z0-9._-]{20,}/g],
  ["OpenAI API token", /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/g],
  ["Anthropic API token", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["OpenRouter API token", /sk-or-v1-[A-Za-z0-9_-]{20,}/g],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{20,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

const forbiddenFiles = [
  /(^|\/)\.env(?:\..+)?$/,
  /(^|\/)(?:auth|runtime)\.json$/,
  /(^|\/)webhook-secret$/,
  /\.(?:pem|key|p12|pfx)$/i,
  /(^|\/)(?:id_rsa|id_ed25519)$/,
];

const allowedAbsolutePathFixtures = new Set(["test/shopping-model.test.mjs"]);

export function scanText(file, text) {
  const findings = [];
  for (const [rule, pattern] of credentialRules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file, line, rule });
    }
  }
  if (!allowedAbsolutePathFixtures.has(file)) {
    const homePattern = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g;
    for (const match of text.matchAll(homePattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file, line, rule: "developer-specific absolute home path" });
    }
  }
  return findings;
}

export function auditTrackedFiles({ listFiles, readFile } = {}) {
  const files = listFiles || execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  for (const file of files) {
    if (forbiddenFiles.some((pattern) => pattern.test(file)) && file !== ".env.example") {
      findings.push({ file, line: 1, rule: "forbidden credential or environment file" });
    }
    let content;
    try {
      content = (readFile || readFileSync)(file);
    } catch {
      continue;
    }
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (buffer.includes(0)) continue;
    findings.push(...scanText(file, buffer.toString("utf8")));
  }
  return findings;
}

export function auditGitHistory({ commits, grepCommit, listCommitFiles } = {}) {
  // git grep uses POSIX ERE rather than JavaScript regular expressions.
  const historyPattern = "(xai-[A-Za-z0-9_-]{20,})|(sk-sp-[A-Za-z0-9._-]{20,})|(sk-(proj|svcacct)-[A-Za-z0-9_-]{20,})|(sk-ant-[A-Za-z0-9_-]{20,})|(sk-or-v1-[A-Za-z0-9_-]{20,})|(gh[pousr]_[A-Za-z0-9_]{20,})|(AKIA[0-9A-Z]{16})|(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)";
  const commitIds = commits || execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const findings = [];
  for (const commit of commitIds) {
    let matchedFiles = [];
    try {
      matchedFiles = grepCommit
        ? grepCommit(commit, historyPattern)
        : execFileSync("git", ["grep", "-Il", "-E", historyPattern, commit], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
    for (const entry of matchedFiles) {
      const file = entry.startsWith(`${commit}:`) ? entry.slice(commit.length + 1) : entry;
      findings.push({ file, line: 1, rule: `credential-shaped content in Git history (${commit.slice(0, 12)})` });
    }

    const files = listCommitFiles
      ? listCommitFiles(commit)
      : execFileSync("git", ["ls-tree", "-r", "--name-only", commit], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const file of files) {
      if (forbiddenFiles.some((pattern) => pattern.test(file)) && file !== ".env.example") {
        findings.push({ file, line: 1, rule: `forbidden credential file in Git history (${commit.slice(0, 12)})` });
      }
    }
  }
  return findings.filter((finding, index, all) => all.findIndex((candidate) => candidate.file === finding.file && candidate.rule === finding.rule) === index);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const findings = [...auditTrackedFiles(), ...auditGitHistory()];
  if (findings.length > 0) {
    process.stderr.write("Public repository audit failed. Matched content is intentionally not printed.\n");
    for (const finding of findings) process.stderr.write(`${finding.file}:${finding.line} — ${finding.rule}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Public repository audit passed: the current tree and complete Git history contain no detected credentials, private key material, or credential files; the current tree contains no developer home paths.\n");
  }
}
