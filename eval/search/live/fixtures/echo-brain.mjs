#!/usr/bin/env node
// echo-brain.mjs — deterministic test brain: reads stdin, replies "echo: <text>".
// Used by panel-e2e-full-loop.test.mjs so the loop is testable without a
// network model. Also serves as the minimal reference for the handler contract:
// stdin = user message (EOF-terminated), stdout = reply, exit 0 = success.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  process.stdout.write(`echo: ${buf.trim()}`);
});
