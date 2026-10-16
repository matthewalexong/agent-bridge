import assert from "node:assert/strict";
import test from "node:test";
import { createClientRegistry, LEGACY_TTL_MS, MAX_LABEL_CHARS } from "../lib/client-registry.mjs";

// A registry whose notion of "alive" and "now" the test controls.
function harness({ legacyTtlMs = LEGACY_TTL_MS } = {}) {
  const alive = new Set();
  let time = 1_000;
  const registry = createClientRegistry({
    isAlive: (pid) => alive.has(pid),
    now: () => time,
    legacyTtlMs,
  });
  return {
    registry,
    start: (pid) => alive.add(pid),
    exit: (pid) => alive.delete(pid),
    advance: (ms) => {
      time += ms;
    },
  };
}

test("no attached clients means no label", () => {
  const { registry } = harness();
  assert.equal(registry.label(), null);
});

test("every live client is named, not just the first to identify", () => {
  const { registry, start } = harness();
  start(101);
  start(202);
  registry.identify({ pid: 101, agent: "DeepSeek" });
  registry.identify({ pid: 202, agent: "Claude Code" });
  assert.equal(registry.label(), "DeepSeek · Claude Code");
});

test("a client that exits is pruned and drops its name from the label", () => {
  const { registry, start, exit } = harness();
  start(101);
  start(202);
  registry.identify({ pid: 101, agent: "DeepSeek" });
  registry.identify({ pid: 202, agent: "Claude Code" });
  exit(101);
  assert.equal(registry.prune(), true, "prune reports that something changed");
  assert.equal(registry.label(), "Claude Code");
  assert.equal(registry.prune(), false, "nothing further to remove");
});

test("the label clears once the last client is gone", () => {
  const { registry, start, exit } = harness();
  start(101);
  registry.identify({ pid: 101, agent: "Claude Code" });
  exit(101);
  registry.prune();
  assert.equal(registry.label(), null);
});

test("a clean detach removes the client immediately", () => {
  const { registry, start } = harness();
  start(101);
  registry.identify({ pid: 101, agent: "Claude Code" });
  registry.detach(101);
  assert.equal(registry.label(), null);
});

test("re-identifying under the same pid renames it rather than adding a second entry", () => {
  const { registry, start } = harness();
  start(101);
  registry.identify({ pid: 101, agent: "Claude" });
  registry.identify({ pid: 101, agent: "Claude Code" });
  assert.equal(registry.label(), "Claude Code");
});

test("an empty identity withdraws that process's entry", () => {
  const { registry, start } = harness();
  start(101);
  registry.identify({ pid: 101, agent: "Claude Code" });
  registry.identify({ pid: 101, agent: "   " });
  assert.equal(registry.label(), null);
});

test("two clients with the same name both count until one leaves", () => {
  const { registry, start, exit } = harness();
  start(101);
  start(202);
  registry.identify({ pid: 101, agent: "Claude Code" });
  registry.identify({ pid: 202, agent: "Claude Code" });
  assert.equal(registry.label(), "Claude Code", "shown once, not twice");
  exit(101);
  registry.prune();
  assert.equal(registry.label(), "Claude Code", "still attached through the second process");
});

test("a pid-less legacy client expires after its TTL, not before", () => {
  const { registry, advance } = harness({ legacyTtlMs: 60_000 });
  registry.identify({ agent: "DeepSeek" });
  advance(59_999);
  assert.equal(registry.prune(), false);
  assert.equal(registry.label(), "DeepSeek");
  advance(1);
  assert.equal(registry.prune(), true);
  assert.equal(registry.label(), null);
});

test("the label is truncated to the panel's name limit", () => {
  const { registry, start } = harness();
  for (let pid = 1; pid <= 6; pid += 1) {
    start(pid);
    registry.identify({ pid, agent: `Harness number ${pid} with a long name` });
  }
  const label = registry.label();
  assert.ok(label.length <= MAX_LABEL_CHARS);
  assert.ok(label.endsWith("…"));
});

test("the default liveness check treats the current process as alive", () => {
  const registry = createClientRegistry();
  registry.identify({ pid: process.pid, agent: "This test" });
  assert.equal(registry.prune(), false);
  assert.equal(registry.label(), "This test");
});
