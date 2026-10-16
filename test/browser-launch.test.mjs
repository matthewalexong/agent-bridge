import assert from "node:assert/strict";
import test from "node:test";
import { BridgeOfflineError } from "../lib/bridge-client.mjs";
import { ensureBridgeConnected, launchChromeApp } from "../lib/browser-launch.mjs";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

function scriptedBridge(outcomes) {
  const calls = [];
  const callBridge = async (method) => {
    calls.push(method);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { callBridge, calls };
}

const offline = () => new BridgeOfflineError("Cannot connect to the Agent Bridge native host");
const connectedStatus = { connected: true, extensionVersion: "0.9.0" };

test("reports connected without opening Chrome when the bridge already answers", async () => {
  const { callBridge, calls } = scriptedBridge([connectedStatus]);
  let launches = 0;
  const result = await ensureBridgeConnected({
    callBridge,
    launch: async () => {
      launches += 1;
    },
    ...fakeClock(),
  });
  assert.deepEqual(result, { connected: true, launched: false, waitedMs: 0, status: connectedStatus });
  assert.equal(launches, 0);
  assert.deepEqual(calls, ["browser.status"]);
});

test("opens Chrome once and waits until the bridge reconnects", async () => {
  const { callBridge, calls } = scriptedBridge([offline(), offline(), connectedStatus]);
  let launches = 0;
  const clock = fakeClock();
  const result = await ensureBridgeConnected({
    callBridge,
    launch: async () => {
      launches += 1;
    },
    ...clock,
    pollMs: 1_000,
  });
  assert.equal(result.connected, true);
  assert.equal(result.launched, true);
  assert.equal(result.waitedMs, 2_000);
  assert.equal(launches, 1);
  assert.equal(calls.length, 3);
});

test("gives up at the timeout and reports the last error it saw", async () => {
  const { callBridge } = scriptedBridge([offline(), offline(), offline(), offline()]);
  let launches = 0;
  const result = await ensureBridgeConnected({
    callBridge,
    launch: async () => {
      launches += 1;
    },
    ...fakeClock(),
    timeoutMs: 3_000,
    pollMs: 1_000,
  });
  assert.equal(result.connected, false);
  assert.equal(result.launched, true);
  assert.equal(result.waitedMs, 3_000);
  assert.match(result.lastError, /Cannot connect to the Agent Bridge native host/);
  assert.equal(launches, 1);
});

test("does not open Chrome for failures other than an offline bridge", async () => {
  const unauthorized = Object.assign(new Error("Unauthorized"), { code: "unauthorized" });
  const { callBridge } = scriptedBridge([unauthorized]);
  let launches = 0;
  await assert.rejects(
    ensureBridgeConnected({
      callBridge,
      launch: async () => {
        launches += 1;
      },
      ...fakeClock(),
    }),
    { code: "unauthorized" },
  );
  assert.equal(launches, 0);
});

test("refuses to open Chrome on platforms other than macOS", async () => {
  await assert.rejects(launchChromeApp({ platform: "linux" }), { code: "unsupported_platform" });
});
