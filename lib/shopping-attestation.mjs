import crypto from "node:crypto";

const ATTESTATION_KEY = crypto.randomBytes(32);
const KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function unsigned(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return null;
  const { artifact_attestation: ignored, ...payload } = artifact;
  return payload;
}

function digest(kind, artifact) {
  return crypto.createHmac("sha256", ATTESTATION_KEY)
    .update(JSON.stringify(stable({ kind, artifact: unsigned(artifact) })))
    .digest("hex");
}

export function attestShoppingArtifact(kind, artifact) {
  if (!KIND_PATTERN.test(kind) || !unsigned(artifact)) throw Object.assign(new Error("Shopping artifact attestation input is invalid"), { code: "shopping_attestation_invalid" });
  const payload = unsigned(artifact);
  return { ...payload, artifact_attestation: `v1.${kind}.${digest(kind, payload)}` };
}

export function verifyShoppingArtifactAttestation(kind, artifact) {
  if (!KIND_PATTERN.test(kind) || !unsigned(artifact)) return false;
  const match = new RegExp(`^v1\\.${kind}\\.([a-f0-9]{64})$`).exec(String(artifact.artifact_attestation || ""));
  if (!match) return false;
  const provided = Buffer.from(match[1], "hex");
  const expected = Buffer.from(digest(kind, artifact), "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
