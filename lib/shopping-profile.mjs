import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writePrivateJsonAtomic } from "./auth-token.mjs";
import { bridgeDirectory } from "./config.mjs";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_FIELDS = 500;
const SENSITIVE_KINDS = new Set(["size", "measurement", "accessibility", "ingredient_avoid"]);
const DEFAULT_TTL_DAYS = { budget: 90, ownership_horizon: 90, delivery: 90, size: 365, measurement: 365, compatibility: 365, accessibility: 365, brand_preference: 365, merchant_preference: 365, feature: 365, condition: 365, color: 365, material_avoid: 730, ingredient_avoid: 730, sustainability: 365, privacy: 365, other: 180 };
const FORBIDDEN_KEY = /(?:password|passcode|secret|api[_ -]?key|access[_ -]?token|cvv|cvc|security[_ -]?code|card[_ -]?(?:number|pan)|bank[_ -]?account|routing[_ -]?number|social[_ -]?security|\bssn\b|address|email|phone)/i;

const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const validDate = (value) => value != null && Number.isFinite(Date.parse(value));
const nowIso = (clock) => new Date(clock()).toISOString();
const unique = (items) => [...new Set(items)];

function fail(message, code) { throw Object.assign(new Error(message), { code }); }
function profileFile(env) { return path.join(bridgeDirectory(env), "shopping-profile.json"); }
function emptyState() { return { schema_version: SCHEMA_VERSION, revision: 0, fields: [] }; }

function validateState(state) {
  if (state?.schema_version !== SCHEMA_VERSION || !Number.isInteger(state?.revision) || !Array.isArray(state?.fields)) fail("Shopping profile file is invalid", "shopping_profile_invalid");
  return state;
}

async function prepareDirectory(env) {
  const directory = bridgeDirectory(env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

async function readState(env) {
  const target = profileFile(env);
  let stat;
  try { stat = await fs.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail("Shopping profile path is not a safe bounded regular file", "shopping_profile_invalid");
  if (process.platform !== "win32") await fs.chmod(target, 0o600);
  return validateState(JSON.parse(await fs.readFile(target, "utf8")));
}

async function withLock(env, callback) {
  const directory = await prepareDirectory(env);
  const lockPath = path.join(directory, "shopping-profile.lock");
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try { handle = await fs.open(lockPath, "wx", 0o600); } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) fail("Could not acquire the shopping profile update lock", "shopping_profile_lock_failed");
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
      await writePrivateJsonAtomic(profileFile(env), state);
    }
    return result.value;
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function normalizeScalar(value) {
  if (typeof value === "string") return clean(value, 1_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  fail("Profile values must be bounded strings, finite numbers, booleans, or arrays of them", "shopping_profile_value_invalid");
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    if (value.length > 100) fail("Profile value array is too large", "shopping_profile_value_invalid");
    return value.map(normalizeScalar);
  }
  return normalizeScalar(value);
}

function containsCredential(value) {
  const strings = (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string");
  return strings.some((item) => /(?:^|\b)(?:sk-|xai-|ghp_|AIza)[A-Za-z0-9_-]{12,}|\b\d{13,19}\b/.test(item));
}

function normalizeList(values = [], limit = 100) {
  return [...new Set(values.map((item) => clean(item, 300).toLowerCase()).filter(Boolean))].sort().slice(0, limit);
}

function normalizeScope(scope = {}) {
  return { categories: normalizeList(scope.categories), product_keys: normalizeList(scope.product_keys), merchants: normalizeList(scope.merchants), contexts: normalizeList(scope.contexts) };
}

function scopeSignature(key, scope) { return crypto.createHash("sha256").update(JSON.stringify({ key, scope })).digest("hex"); }
function valuesEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function expiryFor(input, kind, createdAt) {
  if (input.never_expires === true) {
    if (input.user_explicitly_requested_permanent !== true) fail("Permanent memory requires explicit permanent-memory authorization", "shopping_profile_permanent_consent_required");
    return null;
  }
  if (input.expires_at != null) {
    if (!validDate(input.expires_at) || Date.parse(input.expires_at) <= Date.parse(createdAt)) fail("Profile expiry must be a valid future timestamp", "shopping_profile_expiry_invalid");
    return new Date(input.expires_at).toISOString();
  }
  const days = input.ttl_days ?? DEFAULT_TTL_DAYS[kind] ?? 180;
  if (!Number.isInteger(days) || days < 1 || days > 3_650) fail("Profile TTL is out of range", "shopping_profile_expiry_invalid");
  return new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
}

function effectiveSensitivity(kind, sensitivity) {
  return SENSITIVE_KINDS.has(kind) ? "sensitive" : (sensitivity || "standard");
}

function publicField(field, includeSensitive = false) {
  return { ...field, value: field.sensitivity === "sensitive" && !includeSensitive ? "[redacted]" : field.value };
}

function assertConsent(input, sensitivity) {
  if (input.user_explicitly_requested_memory !== true) fail("Remembering a shopping preference requires an explicit user request", "shopping_profile_consent_required");
  if (sensitivity === "sensitive" && input.sensitive_data_consent !== true) fail("Sensitive shopping-profile data requires explicit sensitive-data consent", "shopping_profile_sensitive_consent_required");
  if (!new Set(["user_explicit", "user_confirmed"]).has(input.provenance?.source_type)) fail("Profile provenance must be user-explicit or user-confirmed", "shopping_profile_provenance_invalid");
  if (input.provenance.confirmed_at != null && !validDate(input.provenance.confirmed_at)) fail("Profile provenance timestamp is invalid", "shopping_profile_provenance_invalid");
}

export async function rememberShoppingProfileField(input, env = process.env, clock = Date.now) {
  const key = clean(input.key, 160).toLowerCase();
  if (!key || FORBIDDEN_KEY.test(key)) fail("This field is not permitted in the shopping profile", "shopping_profile_field_forbidden");
  const value = normalizeValue(input.value);
  if (containsCredential(value)) fail("Credential-like or payment-card data cannot be stored in the shopping profile", "shopping_profile_value_forbidden");
  const sensitivity = effectiveSensitivity(input.kind, input.sensitivity);
  assertConsent(input, sensitivity);
  const scope = normalizeScope(input.scope);
  const signature = scopeSignature(key, scope);
  return withLock(env, async (state) => {
    const existing = state.fields.find((field) => field.signature === signature);
    if (existing) {
      if (valuesEqual(existing.value, value) && existing.kind === input.kind && existing.decision_role === input.decision_role) return { write: false, value: { created: false, state_revision: state.revision, field: publicField(existing, input.return_sensitive_value === true) } };
      fail("A field with this key and scope already exists; update it with its field id and revision", "shopping_profile_field_conflict");
    }
    if (state.fields.length >= MAX_FIELDS) fail("Shopping profile field limit reached", "shopping_profile_limit_reached");
    const timestamp = nowIso(clock);
    const field = {
      id: `profile_${crypto.randomUUID()}`,
      revision: 1,
      status: "active",
      key,
      kind: input.kind,
      decision_role: input.decision_role,
      value,
      unit: clean(input.unit, 100) || null,
      sensitivity,
      scope,
      signature,
      provenance: { source_type: input.provenance.source_type, confirmed_at: input.provenance.confirmed_at || timestamp },
      consent: { explicit_memory: true, sensitive_data: sensitivity === "sensitive", recorded_at: timestamp },
      expires_at: expiryFor(input, input.kind, timestamp),
      created_at: timestamp,
      updated_at: timestamp,
    };
    state.fields.push(field);
    return { value: { created: true, state_revision: state.revision + 1, field: publicField(field, input.return_sensitive_value === true) } };
  });
}

export async function listShoppingProfile(input = {}, env = process.env, clock = Date.now) {
  const state = await readState(env);
  const at = input.evaluated_at || nowIso(clock);
  if (!validDate(at)) fail("Profile evaluation timestamp is invalid", "shopping_profile_date_invalid");
  if (input.include_sensitive === true && input.user_authorized_sensitive_view !== true) fail("Viewing sensitive profile values requires explicit authorization", "shopping_profile_sensitive_use_required");
  let fields = state.fields.filter((field) => input.include_paused === true || field.status === "active");
  if (input.include_expired !== true) fields = fields.filter((field) => field.expires_at == null || Date.parse(field.expires_at) >= Date.parse(at));
  return { state_revision: state.revision, evaluated_at: new Date(at).toISOString(), fields: fields.map((field) => publicField(field, input.include_sensitive === true)) };
}

function matchesScope(scope, context) {
  const dimensions = [["categories", "category"], ["product_keys", "product_key"], ["merchants", "merchant"], ["contexts", "context"]];
  return dimensions.every(([plural, singular]) => !scope[plural].length || (context[singular] && scope[plural].includes(clean(context[singular], 300).toLowerCase())));
}

function specificity(scope) { return (scope.product_keys.length ? 8 : 0) + (scope.categories.length ? 4 : 0) + (scope.merchants.length ? 2 : 0) + (scope.contexts.length ? 1 : 0); }

export async function resolveShoppingProfile(input, env = process.env, clock = Date.now) {
  const state = await readState(env);
  const at = input.evaluated_at || nowIso(clock);
  if (!validDate(at)) fail("Profile evaluation timestamp is invalid", "shopping_profile_date_invalid");
  if (input.include_sensitive === true && input.user_authorized_sensitive_use !== true) fail("Using sensitive profile values requires explicit authorization for this request", "shopping_profile_sensitive_use_required");
  const candidates = state.fields.filter((field) => field.status === "active" && (field.expires_at == null || Date.parse(field.expires_at) >= Date.parse(at)) && matchesScope(field.scope, input.context || {}));
  const keys = unique(candidates.map((field) => field.key));
  const resolved = [];
  const conflicts = [];
  for (const key of keys) {
    const fields = candidates.filter((field) => field.key === key);
    const max = Math.max(...fields.map((field) => specificity(field.scope)));
    const top = fields.filter((field) => specificity(field.scope) === max);
    const values = unique(top.map((field) => JSON.stringify(field.value)));
    if (values.length > 1) {
      conflicts.push({ key, field_ids: top.map((field) => field.id), reason: "equally_specific_values_conflict" });
      continue;
    }
    resolved.push(publicField(top.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0], input.include_sensitive === true));
  }
  const byRole = (role) => resolved.filter((field) => field.decision_role === role);
  return { state_revision: state.revision, evaluated_at: new Date(at).toISOString(), context: input.context || {}, hard_constraints: byRole("hard_constraint"), preferences: byRole("preference"), defaults: byRole("default"), assumptions: byRole("assumption"), conflicts, sensitive_values_included: input.include_sensitive === true, requires_clarification: conflicts.length > 0 };
}

export async function updateShoppingProfileField(input, env = process.env, clock = Date.now) {
  return withLock(env, async (state) => {
    const field = state.fields.find((item) => item.id === input.field_id);
    if (!field) fail("Shopping profile field not found", "shopping_profile_field_not_found");
    if (input.expected_revision !== field.revision) fail("Shopping profile field changed since it was read", "shopping_profile_revision_conflict");
    const changingValue = input.value !== undefined;
    const changingScope = input.scope !== undefined;
    if (input.user_explicitly_requested_update !== true) fail("Changing remembered data requires an explicit user request", "shopping_profile_update_consent_required");
    if (changingValue && field.sensitivity === "sensitive" && input.sensitive_data_consent !== true) fail("Changing sensitive shopping-profile data requires explicit sensitive-data consent", "shopping_profile_sensitive_consent_required");
    if (changingValue) {
      const value = normalizeValue(input.value);
      if (containsCredential(value)) fail("Credential-like or payment-card data cannot be stored in the shopping profile", "shopping_profile_value_forbidden");
      field.value = value;
    }
    if (changingScope) field.scope = normalizeScope(input.scope);
    if (input.status) field.status = input.status;
    if (input.decision_role) field.decision_role = input.decision_role;
    if (input.expires_at !== undefined || input.ttl_days !== undefined || input.never_expires === true) field.expires_at = expiryFor(input, field.kind, nowIso(clock));
    field.signature = scopeSignature(field.key, field.scope);
    if (state.fields.some((item) => item.id !== field.id && item.signature === field.signature)) fail("Another field already uses this key and scope", "shopping_profile_field_conflict");
    field.revision += 1;
    field.updated_at = nowIso(clock);
    return { value: { state_revision: state.revision + 1, field: publicField(field, input.return_sensitive_value === true) } };
  });
}

export async function forgetShoppingProfileField(input, env = process.env) {
  if (input.user_explicitly_requested_forget !== true || input.confirm_permanent_deletion !== true) fail("Permanent forgetting requires an explicit user request and deletion confirmation", "shopping_profile_forget_confirmation_required");
  return withLock(env, async (state) => {
    const index = state.fields.findIndex((item) => item.id === input.field_id);
    if (index < 0) fail("Shopping profile field not found", "shopping_profile_field_not_found");
    const field = state.fields[index];
    if (input.expected_revision !== field.revision) fail("Shopping profile field changed since it was read", "shopping_profile_revision_conflict");
    state.fields.splice(index, 1);
    return { value: { deleted: true, recoverable: false, state_revision: state.revision + 1, field_id: field.id, key: field.key } };
  });
}
