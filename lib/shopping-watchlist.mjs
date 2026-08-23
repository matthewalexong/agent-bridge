import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writePrivateJsonAtomic } from "./auth-token.mjs";
import { bridgeDirectory } from "./config.mjs";
import { analyzeDealQuality } from "./shopping-deal-quality.mjs";
import { canonicalizeProductIdentity, resolveProductIdentities } from "./shopping-identity.mjs";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_WATCHES = 100;
const MAX_STORED_WATCHES = 1_000;
const MAX_OBSERVATIONS_PER_WATCH = 365;
const DEAL_RANK = new Map([["historical_low", 0], ["well_below_typical", 1], ["below_typical", 2], ["typical", 3], ["above_typical", 4], ["insufficient_evidence", 5]]);

const clean = (value) => String(value ?? "").trim();
const finiteMoney = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nowIso = (clock) => new Date(clock()).toISOString();

function watchFile(env) {
  return path.join(bridgeDirectory(env), "shopping-watches.json");
}

function emptyState() {
  return { schema_version: SCHEMA_VERSION, revision: 0, watches: [] };
}

function validateState(state) {
  if (state?.schema_version !== SCHEMA_VERSION || !Number.isInteger(state?.revision) || !Array.isArray(state?.watches)) {
    const error = new Error("Shopping watchlist file is invalid");
    error.code = "watchlist_invalid";
    throw error;
  }
  for (const watch of state.watches) {
    watch.settings = normalizeSettings(watch.settings || {});
    watch.next_check_at ||= watch.created_at || new Date(0).toISOString();
    watch.lease ||= null;
    watch.run_state ||= { consecutive_failures: 0, last_completed_at: null, last_outcome: null };
    watch.recent_runs ||= [];
  }
  return state;
}

async function prepareDirectory(env) {
  const directory = bridgeDirectory(env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

async function readState(env) {
  const target = watchFile(env);
  let stat;
  try { stat = await fs.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    const error = new Error("Shopping watchlist path is not a safe bounded regular file");
    error.code = "watchlist_invalid";
    throw error;
  }
  if (process.platform !== "win32") await fs.chmod(target, 0o600);
  return validateState(JSON.parse(await fs.readFile(target, "utf8")));
}

async function withLock(env, callback) {
  const directory = await prepareDirectory(env);
  const lockPath = path.join(directory, "shopping-watches.lock");
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try { handle = await fs.open(lockPath, "wx", 0o600); } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        const wrapped = new Error("Could not acquire the shopping watchlist update lock");
        wrapped.code = "watchlist_lock_failed";
        throw wrapped;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    const state = await readState(env);
    const result = await callback(state);
    if (result.write !== false) {
      state.revision += 1;
      await writePrivateJsonAtomic(watchFile(env), state);
    }
    return result.value;
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function identityKey(identity, requiredFields) {
  const canonical = canonicalizeProductIdentity(identity);
  const selected = Object.fromEntries(requiredFields.map((field) => [field, canonical[field]]));
  selected.identifiers = canonical.identifiers;
  return crypto.createHash("sha256").update(JSON.stringify(selected)).digest("hex");
}

function assertIdentity(identity, requiredFields) {
  const meaningful = requiredFields.filter((field) => clean(identity[field]));
  const stableCode = Object.values(identity.identifiers || {}).some((value) => clean(value));
  if (!meaningful.length || (!stableCode && !clean(identity.model) && !(clean(identity.brand) && clean(identity.product_line)))) {
    const error = new Error("A watch requires a stable product identity: identifier, model, or brand plus product line");
    error.code = "watch_identity_insufficient";
    throw error;
  }
  const missing = requiredFields.filter((field) => identity[field] == null || identity[field] === "");
  if (missing.length) {
    const error = new Error(`Watch identity is missing required fields: ${missing.join(", ")}`);
    error.code = "watch_identity_insufficient";
    throw error;
  }
}

function normalizeTargets(targets = {}) {
  const normalized = {
    target_price_usd: finiteMoney(targets.target_price_usd) ? Math.round(targets.target_price_usd * 100) / 100 : null,
    maximum_deal_quality: targets.maximum_deal_quality || null,
    minimum_discount_vs_median_percent: typeof targets.minimum_discount_vs_median_percent === "number" && Number.isFinite(targets.minimum_discount_vs_median_percent) ? targets.minimum_discount_vs_median_percent : null,
    match_mode: targets.match_mode || "any",
  };
  if (normalized.target_price_usd === null && normalized.maximum_deal_quality === null && normalized.minimum_discount_vs_median_percent === null) {
    const error = new Error("A watch requires at least one price or deal-quality target");
    error.code = "watch_target_required";
    throw error;
  }
  return normalized;
}

function normalizeSettings(settings = {}, prior = {}) {
  const cooldown = settings.cooldown_hours ?? prior.cooldown_hours ?? 24;
  const drop = settings.realert_drop_usd ?? prior.realert_drop_usd ?? 1;
  const expires = settings.expires_at === undefined ? (prior.expires_at ?? null) : settings.expires_at;
  const interval = settings.check_interval_minutes ?? prior.check_interval_minutes ?? 360;
  const retryBase = settings.retry_base_minutes ?? prior.retry_base_minutes ?? 15;
  if (typeof cooldown !== "number" || !Number.isFinite(cooldown) || cooldown < 0 || cooldown > 8_760) throw Object.assign(new Error("cooldown_hours is out of range"), { code: "watch_settings_invalid" });
  if (!finiteMoney(drop) || drop > 10_000_000) throw Object.assign(new Error("realert_drop_usd is out of range"), { code: "watch_settings_invalid" });
  if (expires !== null && !Number.isFinite(Date.parse(expires))) throw Object.assign(new Error("expires_at must be a valid timestamp"), { code: "watch_settings_invalid" });
  if (!Number.isInteger(interval) || interval < 5 || interval > 10_080) throw Object.assign(new Error("check_interval_minutes is out of range"), { code: "watch_settings_invalid" });
  if (!Number.isInteger(retryBase) || retryBase < 1 || retryBase > 1_440) throw Object.assign(new Error("retry_base_minutes is out of range"), { code: "watch_settings_invalid" });
  return { cooldown_hours: cooldown, realert_drop_usd: drop, expires_at: expires, check_interval_minutes: interval, retry_base_minutes: retryBase };
}

function signature(identityKeyValue, targets, sources) {
  return crypto.createHash("sha256").update(JSON.stringify({ identityKeyValue, targets, sources: [...sources].sort() })).digest("hex");
}

function publicWatch(watch, includeHistory = false) {
  const { signature: ignored, observations, ...safe } = watch;
  return includeHistory ? { ...safe, observations } : { ...safe, observation_count: observations.length };
}

export async function createShoppingWatch(input, env = process.env, clock = Date.now) {
  const requiredFields = input.required_fields?.length ? [...new Set(input.required_fields)] : Object.keys(input.identity || {}).filter((field) => !["identifiers", "bundle_contents", "compatibility_keys"].includes(field));
  assertIdentity(input.identity || {}, requiredFields);
  const targets = normalizeTargets(input.targets);
  const sources = [...new Set((input.sources || []).map(clean).filter(Boolean))];
  const key = identityKey(input.identity, requiredFields);
  const watchSignature = signature(key, targets, sources);
  return withLock(env, async (state) => {
    const existing = state.watches.find((watch) => watch.status !== "archived" && watch.signature === watchSignature);
    if (existing) return { write: false, value: { created: false, state_revision: state.revision, watch: publicWatch(existing) } };
    if (state.watches.length >= MAX_STORED_WATCHES) throw Object.assign(new Error("Stored shopping watch limit reached"), { code: "watch_storage_limit_reached" });
    if (state.watches.filter((watch) => watch.status !== "archived").length >= MAX_WATCHES) throw Object.assign(new Error("Active shopping watch limit reached"), { code: "watch_limit_reached" });
    const timestamp = nowIso(clock);
    const watch = {
      id: `watch_${crypto.randomUUID()}`,
      revision: 1,
      status: "active",
      label: clean(input.label).slice(0, 200) || null,
      identity: input.identity,
      canonical_identity: canonicalizeProductIdentity(input.identity),
      identity_key: key,
      required_fields: requiredFields,
      targets,
      sources,
      settings: normalizeSettings(input.settings),
      signature: watchSignature,
      created_at: timestamp,
      updated_at: timestamp,
      last_evaluated_at: null,
      last_alert: null,
      next_check_at: timestamp,
      lease: null,
      run_state: { consecutive_failures: 0, last_completed_at: null, last_outcome: null },
      recent_runs: [],
      observations: [],
    };
    state.watches.push(watch);
    return { value: { created: true, state_revision: state.revision + 1, watch: publicWatch(watch) } };
  });
}

export async function listShoppingWatches(input = {}, env = process.env) {
  const state = await readState(env);
  const statuses = input.include_archived === true ? null : new Set(input.statuses || ["active", "paused"]);
  return { state_revision: state.revision, watches: state.watches.filter((watch) => !statuses || statuses.has(watch.status)).map((watch) => publicWatch(watch, input.include_history === true)) };
}

export async function updateShoppingWatch(input, env = process.env, clock = Date.now) {
  return withLock(env, async (state) => {
    const watch = state.watches.find((item) => item.id === input.watch_id);
    if (!watch) { const error = new Error("Shopping watch not found"); error.code = "watch_not_found"; throw error; }
    if (input.expected_revision != null && input.expected_revision !== watch.revision) { const error = new Error("Shopping watch changed since it was read"); error.code = "watch_revision_conflict"; throw error; }
    if (input.status) {
      watch.status = input.status;
      if (input.status !== "active") watch.lease = null;
      if (input.status === "active" && watch.next_check_at == null) watch.next_check_at = nowIso(clock);
    }
    if (input.label !== undefined) watch.label = clean(input.label).slice(0, 200) || null;
    if (input.targets) watch.targets = normalizeTargets(input.targets);
    if (input.sources) watch.sources = [...new Set(input.sources.map(clean).filter(Boolean))];
    if (input.settings) watch.settings = normalizeSettings(input.settings, watch.settings);
    watch.signature = signature(watch.identity_key, watch.targets, watch.sources);
    if (watch.status !== "archived" && state.watches.some((item) => item.id !== watch.id && item.status !== "archived" && item.signature === watch.signature)) {
      const error = new Error("An equivalent active shopping watch already exists");
      error.code = "watch_duplicate";
      throw error;
    }
    watch.revision += 1;
    watch.updated_at = nowIso(clock);
    return { value: { state_revision: state.revision + 1, watch: publicWatch(watch) } };
  });
}

function safetyBlock(current, identityResolution) {
  if (identityResolution.classification !== "exact_match") return "identity_not_exact";
  if (current.landed_price_verified !== true || !finiteMoney(current.landed_total_usd)) return "landed_price_unverified";
  if (current.stock !== "in_stock") return "availability_unverified";
  if (!new Set(["low", "acceptable"]).has(current.risk_status)) return current.risk_status === "elevated" ? "offer_risk_elevated" : "offer_risk_unresolved";
  return null;
}

function targetMatches(watch, current, deal) {
  const checks = [];
  if (watch.targets.target_price_usd !== null) checks.push({ code: "target_price_reached", matched: current.landed_total_usd <= watch.targets.target_price_usd });
  if (watch.targets.maximum_deal_quality !== null) checks.push({ code: "deal_quality_reached", matched: DEAL_RANK.get(deal.deal_quality) <= DEAL_RANK.get(watch.targets.maximum_deal_quality) });
  if (watch.targets.minimum_discount_vs_median_percent !== null) checks.push({ code: "median_discount_reached", matched: deal.history.current_vs_median_percent !== null && -deal.history.current_vs_median_percent >= watch.targets.minimum_discount_vs_median_percent });
  const triggered = watch.targets.match_mode === "all" ? checks.every((check) => check.matched) : checks.some((check) => check.matched);
  return { triggered, checks, reasons: checks.filter((check) => check.matched).map((check) => check.code) };
}

export async function evaluateShoppingWatch(input, env = process.env, clock = Date.now) {
  return withLock(env, async (state) => {
    const watch = state.watches.find((item) => item.id === input.watch_id);
    if (!watch) { const error = new Error("Shopping watch not found"); error.code = "watch_not_found"; throw error; }
    const evaluatedAt = nowIso(clock);
    const expired = watch.settings.expires_at && Date.parse(watch.settings.expires_at) <= Date.parse(evaluatedAt);
    if (watch.status !== "active" || expired) {
      return { write: false, value: { watch_id: watch.id, evaluated: false, reason: expired ? "watch_expired" : `watch_${watch.status}`, alert: { should_notify: false, purchase_allowed: false } } };
    }
    if (input.run_id && watch.lease?.run_id !== input.run_id) {
      const error = new Error("Scheduled watch evaluation does not hold the active lease");
      error.code = "watch_lease_conflict";
      throw error;
    }

    const identity = resolveProductIdentities({ target: watch.identity, candidates: [{ ...input.candidate_identity, id: "current" }], required_fields: watch.required_fields }).resolutions[0];
    const current = { ...input.current, product_key: watch.identity_key, exact_identity: identity.classification === "exact_match" };
    const block = safetyBlock(current, identity);
    const deal = analyzeDealQuality({ current, observations: watch.observations, policy: { ...(input.history_policy || {}), evaluated_at: evaluatedAt }, user_context: { urgency: "flexible", target_price_usd: watch.targets.target_price_usd } });
    const matches = block ? { triggered: false, checks: [], reasons: [] } : targetMatches(watch, current, deal);
    let shouldNotify = matches.triggered;
    let suppressedReason = block;
    const previous = watch.last_alert;
    if (shouldNotify && previous) {
      const elapsedHours = (Date.parse(evaluatedAt) - Date.parse(previous.sent_at)) / 3_600_000;
      const improved = current.landed_total_usd <= previous.landed_total_usd - watch.settings.realert_drop_usd;
      if (elapsedHours < watch.settings.cooldown_hours && !improved) { shouldNotify = false; suppressedReason = "cooldown_duplicate"; }
    }

    const capturedAt = Date.parse(input.captured_at || evaluatedAt);
    if (!block && Number.isFinite(capturedAt) && capturedAt <= Date.parse(evaluatedAt) && input.source?.source_type !== "search_snippet") {
      watch.observations.push({ product_key: watch.identity_key, variant: current.variant, condition: current.condition, currency: current.currency || "USD", landed_total_usd: current.landed_total_usd, verified: true, observed_at: input.captured_at || evaluatedAt, source: input.source });
      watch.observations = watch.observations.slice(-MAX_OBSERVATIONS_PER_WATCH);
    }
    watch.last_evaluated_at = evaluatedAt;
    watch.updated_at = evaluatedAt;
    watch.revision += 1;
    if (shouldNotify) watch.last_alert = { sent_at: evaluatedAt, landed_total_usd: current.landed_total_usd, merchant: input.current.merchant || null, offer_url: input.current.offer_url || null, reasons: matches.reasons };

    return {
      value: {
        state_revision: state.revision + 1,
        watch_id: watch.id,
        evaluated: true,
        identity,
        deal,
        target_checks: matches.checks,
        alert: {
          should_notify: shouldNotify,
          suppressed_reason: shouldNotify ? null : suppressedReason || "targets_not_reached",
          reasons: shouldNotify ? matches.reasons : [],
          landed_total_usd: finiteMoney(current.landed_total_usd) ? current.landed_total_usd : null,
          merchant: input.current.merchant || null,
          offer_url: input.current.offer_url || null,
          purchase_allowed: false,
          checkout_confirmation_required: true,
        },
        watch: publicWatch(watch),
      },
    };
  });
}

export async function claimDueShoppingWatches(input, env = process.env, clock = Date.now) {
  const timestamp = input.at || nowIso(clock);
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) throw Object.assign(new Error("Claim time is invalid"), { code: "watch_claim_invalid" });
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const leaseSeconds = Math.max(30, Math.min(3_600, input.lease_seconds ?? 300));
  return withLock(env, async (state) => {
    const due = state.watches
      .filter((watch) => watch.status === "active")
      .filter((watch) => !watch.settings.expires_at || Date.parse(watch.settings.expires_at) > at)
      .filter((watch) => Date.parse(watch.next_check_at || watch.created_at) <= at)
      .filter((watch) => !watch.lease || Date.parse(watch.lease.expires_at) <= at)
      .sort((a, b) => Date.parse(a.next_check_at) - Date.parse(b.next_check_at) || a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
    if (!due.length) return { write: false, value: { state_revision: state.revision, claimed_at: new Date(at).toISOString(), runs: [] } };
    const runs = due.map((watch) => {
      const runId = `run_${crypto.randomUUID()}`;
      watch.lease = { run_id: runId, worker_id: clean(input.worker_id).slice(0, 200), claimed_at: new Date(at).toISOString(), expires_at: new Date(at + leaseSeconds * 1_000).toISOString() };
      watch.revision += 1;
      watch.updated_at = new Date(at).toISOString();
      return { run_id: runId, lease_expires_at: watch.lease.expires_at, watch: publicWatch(watch) };
    });
    return { value: { state_revision: state.revision + 1, claimed_at: new Date(at).toISOString(), runs } };
  });
}

export async function completeShoppingWatchRun(input, env = process.env, clock = Date.now) {
  return withLock(env, async (state) => {
    const watch = state.watches.find((item) => item.id === input.watch_id);
    if (!watch) throw Object.assign(new Error("Shopping watch not found"), { code: "watch_not_found" });
    if (watch.lease?.run_id !== input.run_id) throw Object.assign(new Error("Shopping watch run no longer holds its lease"), { code: "watch_lease_conflict" });
    const completedAt = input.completed_at || nowIso(clock);
    const completed = Date.parse(completedAt);
    if (!Number.isFinite(completed)) throw Object.assign(new Error("Run completion time is invalid"), { code: "watch_run_invalid" });
    const failed = input.outcome === "failed";
    watch.run_state.consecutive_failures = failed ? watch.run_state.consecutive_failures + 1 : 0;
    watch.run_state.last_completed_at = new Date(completed).toISOString();
    watch.run_state.last_outcome = input.outcome;
    const normalDelay = watch.settings.check_interval_minutes;
    const retryDelay = Math.min(normalDelay, watch.settings.retry_base_minutes * (2 ** Math.max(0, watch.run_state.consecutive_failures - 1)));
    const delayMinutes = failed ? retryDelay : normalDelay;
    watch.next_check_at = new Date(completed + delayMinutes * 60_000).toISOString();
    watch.recent_runs.push({ run_id: input.run_id, worker_id: watch.lease.worker_id, claimed_at: watch.lease.claimed_at, completed_at: new Date(completed).toISOString(), outcome: input.outcome, error_code: clean(input.error_code).slice(0, 120) || null, evaluated_offers: Math.max(0, Math.min(10_000, input.evaluated_offers ?? 0)), alert_decisions: Math.max(0, Math.min(10_000, input.alert_decisions ?? 0)) });
    watch.recent_runs = watch.recent_runs.slice(-20);
    watch.lease = null;
    watch.revision += 1;
    watch.updated_at = new Date(completed).toISOString();
    return { value: { state_revision: state.revision + 1, watch: publicWatch(watch), next_check_at: watch.next_check_at } };
  });
}
