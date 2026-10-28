// Settle step for tabs.navigate and page actions. After the operation, wait
// for the tab's load to complete and then for a short window with no DOM
// mutations, so the next snapshot sees the rendered page instead of a
// half-loaded one. Waiting never throws: a timeout returns settled:false with
// the elapsed time and a reason.
//
// The service worker forwards chrome.tabs.onUpdated/onRemoved here instead of
// this module adding its own listeners, so one listener per event stays the
// rule (the test fakes rely on it).

export const WAIT_UNTIL_VALUES = Object.freeze(["none", "load", "settled"]);
export const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;
export const MAX_SETTLE_TIMEOUT_MS = 20_000;
export const DOM_QUIET_MS = 400;
// executeScript can hang on a frozen page; the in-page timer gets this much
// slack before the page counts as busy.
const SCRIPT_SLACK_MS = 250;
const MAX_DETAIL_CHARS = 200;
const SCRIPTABLE_URL = /^(https?|file):/i;
const TIMED_OUT = Symbol("timed_out");

function invalidRequest(message) {
  const error = new Error(message);
  error.code = "invalid_request";
  return error;
}

// Validates the caller's waitUntil/timeoutMs. budgetEndsAt is an absolute
// deadline the wait never passes, whatever timeoutMs asks for.
export function settleOptions(params = {}, { budgetEndsAt = Infinity } = {}) {
  const waitUntil = params.waitUntil ?? "settled";
  if (!WAIT_UNTIL_VALUES.includes(waitUntil)) {
    throw invalidRequest("waitUntil must be none, load, or settled");
  }
  const timeoutMs = params.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_SETTLE_TIMEOUT_MS) {
    throw invalidRequest(`timeoutMs must be an integer from 0 to ${MAX_SETTLE_TIMEOUT_MS}`);
  }
  return { waitUntil, timeoutMs, budgetEndsAt };
}

// Injected into the page's isolated world, so it must stay self-contained.
// Resolves quiet:true once quietMs pass without a mutation, or quiet:false
// when maxMs runs out first.
export function waitForDomQuiet(quietMs, maxMs) {
  return new Promise((resolve) => {
    let mutations = 0;
    let quietTimer = null;
    let maxTimer = null;
    const finish = (quiet) => {
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      observer.disconnect();
      resolve({ quiet, mutations });
    };
    const armQuietTimer = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    };
    const observer = new MutationObserver((records) => {
      mutations += records.length;
      armQuietTimer();
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    // Armed before maxTimer so an equal delay still reports a quiet page.
    armQuietTimer();
    maxTimer = setTimeout(() => finish(false), maxMs);
  });
}

function isLoading(tab) {
  return tab?.status === "loading" || Boolean(tab?.pendingUrl);
}

export function createPageSettle(chrome, { quietMs = DOM_QUIET_MS, now = () => Date.now() } = {}) {
  const watchersByTabId = new Map();

  function watch(tabId) {
    const watcher = { tabId, version: 0, navigation: false, removed: false, wake: null };
    let watchers = watchersByTabId.get(tabId);
    if (!watchers) watchersByTabId.set(tabId, (watchers = new Set()));
    watchers.add(watcher);
    watcher.dispose = () => {
      watchers.delete(watcher);
      if (watchers.size === 0 && watchersByTabId.get(tabId) === watchers) watchersByTabId.delete(tabId);
    };
    return watcher;
  }

  function notify(tabId, update) {
    for (const watcher of watchersByTabId.get(tabId) || []) {
      update(watcher);
      watcher.version += 1;
      watcher.wake?.();
    }
  }

  function handleTabUpdated(tabId, changeInfo = {}) {
    const startsLoad = changeInfo.status === "loading" || typeof changeInfo.url === "string";
    notify(tabId, (watcher) => {
      if (startsLoad) watcher.navigation = true;
    });
  }

  function handleTabRemoved(tabId) {
    notify(tabId, (watcher) => {
      watcher.removed = true;
    });
  }

  // Resolves true on the first tab event after `version`, false at `until`.
  function nextEvent(watcher, version, until) {
    if (watcher.version !== version || watcher.removed) return Promise.resolve(true);
    const delay = until - now();
    if (delay <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        watcher.wake = null;
        resolve(false);
      }, delay);
      watcher.wake = () => {
        clearTimeout(timer);
        watcher.wake = null;
        resolve(true);
      };
    });
  }

  async function currentTab(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  // "complete" | "timeout" | "removed". Clearing the navigation flag before
  // reading the tab means a load that starts after this read is still seen.
  async function waitForLoad(watcher, deadline) {
    for (;;) {
      if (watcher.removed) return "removed";
      watcher.navigation = false;
      const version = watcher.version;
      const tab = await currentTab(watcher.tabId);
      if (!tab || watcher.removed) return "removed";
      if (!isLoading(tab)) return "complete";
      if (!(await nextEvent(watcher, version, deadline))) return "timeout";
    }
  }

  // Lets an action start a load within the quiet window when the caller
  // asked for waitUntil:"load", which observes no DOM.
  async function waitForLoadStart(watcher, until) {
    while (!watcher.navigation && !watcher.removed && await nextEvent(watcher, watcher.version, until));
    return { outcome: watcher.removed ? "removed" : "skipped" };
  }

  // outcome: "quiet" | "busy" | "skipped" (nothing to observe) | "removed" | "unavailable"
  async function waitForQuiet(watcher, deadline) {
    const tab = await currentTab(watcher.tabId);
    if (!tab || watcher.removed) return { outcome: "removed" };
    if (!SCRIPTABLE_URL.test(tab.url || "")) return { outcome: "skipped" };
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: "busy" };
    let timer = null;
    try {
      const injection = Promise.resolve(chrome.scripting.executeScript({
        target: { tabId: watcher.tabId },
        func: waitForDomQuiet,
        args: [quietMs, remaining],
      }));
      injection.catch(() => {});
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, remaining + SCRIPT_SLACK_MS, TIMED_OUT);
      });
      const results = await Promise.race([injection, timeout]);
      if (results === TIMED_OUT) return { outcome: "busy" };
      const value = results?.[0]?.result;
      if (value?.quiet === true) return { outcome: "quiet" };
      if (value?.quiet === false) return { outcome: "busy" };
      return { outcome: "unavailable", detail: "The page did not report DOM activity." };
    } catch (error) {
      return { outcome: "unavailable", detail: String(error?.message || error).slice(0, MAX_DETAIL_CHARS) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function settleWatched(watcher, kind, options, startedAt, wasLoading) {
    const deadline = Math.min(startedAt + options.timeoutMs, options.budgetEndsAt);
    let navigated = false;
    const report = (settled, reason, detail) => ({
      settled,
      waitUntil: options.waitUntil,
      elapsedMs: Math.max(0, now() - startedAt),
      ...(kind === "action" ? { navigated } : {}),
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
    });
    const fromQuiet = ({ outcome, detail }) => {
      if (outcome === "quiet" || outcome === "skipped") return report(true);
      if (outcome === "removed") return report(false, "tab_closed");
      if (outcome === "busy") return report(false, "dom_busy");
      return report(false, "dom_unavailable", detail);
    };

    if (kind === "action") {
      // The first quiet window doubles as the time an action has to start a
      // load, so an action that changes nothing returns within it.
      const first = options.waitUntil === "load"
        ? await waitForLoadStart(watcher, Math.min(deadline, now() + quietMs))
        : await waitForQuiet(watcher, deadline);
      if (first.outcome === "removed" || watcher.removed) return report(false, "tab_closed");
      const tab = await currentTab(watcher.tabId);
      if (!tab) return report(false, "tab_closed");
      // A load that was already running before the action is not the
      // action's; waiting on it could cost the full timeout on a page whose
      // load never finishes.
      const startedLoad = watcher.navigation || (isLoading(tab) && !wasLoading);
      if (!startedLoad) return fromQuiet(first);
      navigated = true;
    }

    for (;;) {
      const load = await waitForLoad(watcher, deadline);
      if (load === "removed") return report(false, "tab_closed");
      if (load === "timeout") return report(false, "load_timeout");
      if (options.waitUntil === "load") return report(true);
      const quiet = await waitForQuiet(watcher, deadline);
      if (quiet.outcome === "removed" || watcher.removed) return report(false, "tab_closed");
      if (!watcher.navigation) return fromQuiet(quiet);
      // Another load began while the DOM was observed (a client-side
      // redirect, for example); settle that one instead.
      if (now() >= deadline) return report(false, "load_timeout");
    }
  }

  // Runs operation, then settles the tab. kind is "navigation" or "action".
  // Returns { value, settle }; settle is null for waitUntil:"none". Errors
  // from operation propagate; the settle step itself never throws.
  async function run(tabId, kind, options, operation) {
    if (options.waitUntil === "none") return { value: await operation(), settle: null };
    const watcher = watch(tabId);
    try {
      const wasLoading = kind === "action" && isLoading(await currentTab(tabId));
      const value = await operation();
      const startedAt = now();
      let settle;
      try {
        settle = await settleWatched(watcher, kind, options, startedAt, wasLoading);
      } catch (error) {
        settle = {
          settled: false,
          waitUntil: options.waitUntil,
          elapsedMs: Math.max(0, now() - startedAt),
          reason: "settle_error",
          detail: String(error?.message || error).slice(0, MAX_DETAIL_CHARS),
        };
      }
      return { value, settle };
    } finally {
      watcher.dispose();
    }
  }

  return { run, handleTabUpdated, handleTabRemoved };
}
