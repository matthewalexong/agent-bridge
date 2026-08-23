import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetShoppingProfileField, listShoppingProfile, rememberShoppingProfileField, resolveShoppingProfile, updateShoppingProfileField } from "../lib/shopping-profile.mjs";

const BASE = Date.parse("2026-08-22T20:00:00.000Z");

async function environment(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shopping-profile-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { CHROME_AGENT_BRIDGE_DIR: directory };
}

function memory(overrides = {}) {
  return {
    key: "noise_cancellation",
    kind: "feature",
    decision_role: "preference",
    value: true,
    scope: { categories: ["headphones"] },
    provenance: { source_type: "user_explicit", confirmed_at: "2026-08-22T20:00:00.000Z" },
    user_explicitly_requested_memory: true,
    ...overrides,
  };
}

test("profile creation requires an explicit user memory request", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => rememberShoppingProfileField(memory({ user_explicitly_requested_memory: false }), env), { code: "shopping_profile_consent_required" });
});

test("sensitive fields require consent and are redacted by default", async (context) => {
  const env = await environment(context);
  const shoe = memory({ key: "shoe_size", kind: "size", decision_role: "hard_constraint", value: 10, scope: { categories: ["shoes"] } });
  await assert.rejects(() => rememberShoppingProfileField(shoe, env), { code: "shopping_profile_sensitive_consent_required" });
  const created = await rememberShoppingProfileField({ ...shoe, sensitive_data_consent: true }, env, () => BASE);
  assert.equal(created.field.sensitivity, "sensitive");
  assert.equal(created.field.value, "[redacted]");
  const listed = await listShoppingProfile({}, env, () => BASE);
  assert.equal(listed.fields[0].value, "[redacted]");
});

test("profile persistence is private and identical remembers are idempotent", async (context) => {
  const env = await environment(context);
  const first = await rememberShoppingProfileField(memory(), env, () => BASE);
  const second = await rememberShoppingProfileField(memory(), env, () => BASE + 1_000);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.field.id, first.field.id);
  const stat = await fs.stat(path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-profile.json"));
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
});

test("a different value at the same key and scope requires an explicit update", async (context) => {
  const env = await environment(context);
  await rememberShoppingProfileField(memory(), env, () => BASE);
  await assert.rejects(() => rememberShoppingProfileField(memory({ value: false }), env, () => BASE), { code: "shopping_profile_field_conflict" });
});

test("product scope overrides category and global values deterministically", async (context) => {
  const env = await environment(context);
  await rememberShoppingProfileField(memory({ key: "color", kind: "color", value: "black", scope: {} }), env, () => BASE);
  await rememberShoppingProfileField(memory({ key: "color", kind: "color", value: "blue", scope: { categories: ["headphones"] } }), env, () => BASE + 1_000);
  await rememberShoppingProfileField(memory({ key: "color", kind: "color", value: "red", scope: { product_keys: ["headphone-x"] } }), env, () => BASE + 2_000);
  const product = await resolveShoppingProfile({ context: { category: "headphones", product_key: "headphone-x" } }, env, () => BASE + 3_000);
  const category = await resolveShoppingProfile({ context: { category: "headphones", product_key: "other" } }, env, () => BASE + 3_000);
  const global = await resolveShoppingProfile({ context: { category: "speakers" } }, env, () => BASE + 3_000);
  assert.equal(product.preferences[0].value, "red");
  assert.equal(category.preferences[0].value, "blue");
  assert.equal(global.preferences[0].value, "black");
});

test("equally specific overlapping values become a clarification conflict", async (context) => {
  const env = await environment(context);
  await rememberShoppingProfileField(memory({ key: "color", kind: "color", value: "black", scope: { categories: ["shoes", "clothing"] } }), env, () => BASE);
  await rememberShoppingProfileField(memory({ key: "color", kind: "color", value: "blue", scope: { categories: ["shoes"] } }), env, () => BASE + 1_000);
  const result = await resolveShoppingProfile({ context: { category: "shoes" } }, env, () => BASE + 2_000);
  assert.equal(result.requires_clarification, true);
  assert.deepEqual(result.preferences, []);
  assert.equal(result.conflicts[0].key, "color");
});

test("expired memories are excluded while permanent memory needs separate consent", async (context) => {
  const env = await environment(context);
  await rememberShoppingProfileField(memory({ ttl_days: 1 }), env, () => BASE);
  assert.equal((await listShoppingProfile({}, env, () => BASE + 2 * 86_400_000)).fields.length, 0);
  await assert.rejects(() => rememberShoppingProfileField(memory({ key: "material", kind: "material_avoid", value: "wool", never_expires: true }), env, () => BASE), { code: "shopping_profile_permanent_consent_required" });
  const permanent = await rememberShoppingProfileField(memory({ key: "material", kind: "material_avoid", value: "wool", never_expires: true, user_explicitly_requested_permanent: true }), env, () => BASE);
  assert.equal(permanent.field.expires_at, null);
});

test("sensitive viewing and request-time use require separate authorization", async (context) => {
  const env = await environment(context);
  await rememberShoppingProfileField(memory({ key: "shoe_size", kind: "size", decision_role: "hard_constraint", value: 10, scope: { categories: ["shoes"] }, sensitive_data_consent: true }), env, () => BASE);
  await assert.rejects(() => listShoppingProfile({ include_sensitive: true }, env, () => BASE), { code: "shopping_profile_sensitive_use_required" });
  await assert.rejects(() => resolveShoppingProfile({ context: { category: "shoes" }, include_sensitive: true }, env, () => BASE), { code: "shopping_profile_sensitive_use_required" });
  const result = await resolveShoppingProfile({ context: { category: "shoes" }, include_sensitive: true, user_authorized_sensitive_use: true }, env, () => BASE);
  assert.equal(result.hard_constraints[0].value, 10);
  assert.equal(result.sensitive_values_included, true);
});

test("resolved fields stay separated by decision role", async (context) => {
  const env = await environment(context);
  await rememberShoppingProfileField(memory({ key: "compatibility", kind: "compatibility", decision_role: "hard_constraint", value: "usb-c", scope: {} }), env, () => BASE);
  await rememberShoppingProfileField(memory({ key: "brand", kind: "brand_preference", decision_role: "preference", value: "Acme", scope: {} }), env, () => BASE);
  await rememberShoppingProfileField(memory({ key: "condition", kind: "condition", decision_role: "default", value: "new", scope: {} }), env, () => BASE);
  await rememberShoppingProfileField(memory({ key: "horizon", kind: "ownership_horizon", decision_role: "assumption", value: 36, unit: "months", scope: {} }), env, () => BASE);
  const result = await resolveShoppingProfile({ context: {} }, env, () => BASE);
  assert.equal(result.state_revision, 4);
  assert.equal(result.hard_constraints[0].key, "compatibility");
  assert.equal(result.preferences[0].key, "brand");
  assert.equal(result.defaults[0].key, "condition");
  assert.equal(result.assumptions[0].key, "horizon");
});

test("updates require intent, revision matching, and renewed sensitive consent", async (context) => {
  const env = await environment(context);
  const created = await rememberShoppingProfileField(memory({ key: "shoe_size", kind: "size", decision_role: "hard_constraint", value: 10, sensitivity: "sensitive", sensitive_data_consent: true }), env, () => BASE);
  await assert.rejects(() => updateShoppingProfileField({ field_id: created.field.id, expected_revision: 1, value: 11 }, env), { code: "shopping_profile_update_consent_required" });
  await assert.rejects(() => updateShoppingProfileField({ field_id: created.field.id, expected_revision: 1, value: 11, user_explicitly_requested_update: true }, env), { code: "shopping_profile_sensitive_consent_required" });
  const updated = await updateShoppingProfileField({ field_id: created.field.id, expected_revision: 1, value: 11, user_explicitly_requested_update: true, sensitive_data_consent: true, return_sensitive_value: true }, env, () => BASE + 1_000);
  assert.equal(updated.field.value, 11);
  assert.equal(updated.field.revision, 2);
  await assert.rejects(() => updateShoppingProfileField({ field_id: created.field.id, expected_revision: 1, status: "paused", user_explicitly_requested_update: true }, env), { code: "shopping_profile_revision_conflict" });
});

test("pause and resume are explicit and do not delete the field", async (context) => {
  const env = await environment(context);
  const created = await rememberShoppingProfileField(memory(), env, () => BASE);
  const paused = await updateShoppingProfileField({ field_id: created.field.id, expected_revision: 1, status: "paused", user_explicitly_requested_update: true }, env, () => BASE + 1_000);
  assert.equal(paused.field.status, "paused");
  assert.equal((await listShoppingProfile({}, env, () => BASE + 2_000)).fields.length, 0);
  assert.equal((await listShoppingProfile({ include_paused: true }, env, () => BASE + 2_000)).fields.length, 1);
});

test("credentials, card-like values, and direct contact fields are forbidden", async (context) => {
  const env = await environment(context);
  await assert.rejects(() => rememberShoppingProfileField(memory({ key: "api_key", value: "not-even-needed" }), env), { code: "shopping_profile_field_forbidden" });
  await assert.rejects(() => rememberShoppingProfileField(memory({ key: "loyalty_note", value: "4111111111111111" }), env), { code: "shopping_profile_value_forbidden" });
  await assert.rejects(() => rememberShoppingProfileField(memory({ key: "delivery_address", value: "123 Main" }), env), { code: "shopping_profile_field_forbidden" });
});

test("permanent forgetting requires confirmation and actually erases the field", async (context) => {
  const env = await environment(context);
  const created = await rememberShoppingProfileField(memory(), env, () => BASE);
  await assert.rejects(() => forgetShoppingProfileField({ field_id: created.field.id, expected_revision: 1, user_explicitly_requested_forget: true, confirm_permanent_deletion: false }, env), { code: "shopping_profile_forget_confirmation_required" });
  const forgotten = await forgetShoppingProfileField({ field_id: created.field.id, expected_revision: 1, user_explicitly_requested_forget: true, confirm_permanent_deletion: true }, env);
  assert.equal(forgotten.deleted, true);
  assert.equal(forgotten.recoverable, false);
  assert.equal((await listShoppingProfile({ include_paused: true, include_expired: true }, env, () => BASE)).fields.length, 0);
  const raw = JSON.parse(await fs.readFile(path.join(env.CHROME_AGENT_BRIDGE_DIR, "shopping-profile.json"), "utf8"));
  assert.equal(JSON.stringify(raw).includes("noise_cancellation"), false);
});

test("concurrent distinct remembers are serialized without data loss", async (context) => {
  const env = await environment(context);
  await Promise.all([
    rememberShoppingProfileField(memory({ key: "color", kind: "color", value: "black" }), env, () => BASE),
    rememberShoppingProfileField(memory({ key: "brand", kind: "brand_preference", value: "Acme" }), env, () => BASE),
  ]);
  const listed = await listShoppingProfile({}, env, () => BASE);
  assert.equal(listed.fields.length, 2);
  assert.equal(listed.state_revision, 2);
});
