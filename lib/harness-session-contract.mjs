export const HARNESS_SESSION_CONTRACT_VERSION = 2;

export const HARNESS_SESSION_CAPABILITIES = Object.freeze({
  CREATE: "sessions.create:v1",
  LIST: "sessions.list:v1",
  LOAD_DISPLAY_TRANSCRIPT: "sessions.load-display-transcript:v1",
  RESUME: "sessions.resume:v1",
  TITLE_FROM_PROMPT: "sessions.title-from-prompt:v1",
  RENAME: "sessions.rename:v1",
  ARCHIVE: "sessions.archive:v1",
  PIN: "sessions.pin:v1",
  INTERACTIVE_QUESTIONS: "sessions.interactive-questions:v1",
});

const knownCapabilities = new Set(Object.values(HARNESS_SESSION_CAPABILITIES));
const requiredCapabilities = [
  HARNESS_SESSION_CAPABILITIES.CREATE,
  HARNESS_SESSION_CAPABILITIES.LIST,
  HARNESS_SESSION_CAPABILITIES.LOAD_DISPLAY_TRANSCRIPT,
  HARNESS_SESSION_CAPABILITIES.RESUME,
  HARNESS_SESSION_CAPABILITIES.TITLE_FROM_PROMPT,
];
const capabilityMethods = new Map([
  [HARNESS_SESSION_CAPABILITIES.CREATE, "createSession"],
  [HARNESS_SESSION_CAPABILITIES.LIST, "listSessions"],
  [HARNESS_SESSION_CAPABILITIES.LOAD_DISPLAY_TRANSCRIPT, "loadSession"],
  [HARNESS_SESSION_CAPABILITIES.RESUME, "resumeSession"],
  [HARNESS_SESSION_CAPABILITIES.TITLE_FROM_PROMPT, "titleFromPrompt"],
  [HARNESS_SESSION_CAPABILITIES.RENAME, "renameSession"],
  [HARNESS_SESSION_CAPABILITIES.ARCHIVE, "archiveSession"],
  [HARNESS_SESSION_CAPABILITIES.PIN, "pinSession"],
  [HARNESS_SESSION_CAPABILITIES.INTERACTIVE_QUESTIONS, "waitForQuestion"],
]);

function invalid(message) {
  const error = new Error(message);
  error.code = "harness_session_adapter_invalid";
  return error;
}

function normalizedCapabilities(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) throw invalid("Adapter capabilities must be a unique array");
  for (const capability of value) {
    if (!knownCapabilities.has(capability)) throw invalid(`Unknown harness session capability: ${capability}`);
  }
  return [...value].sort();
}

export function validateHarnessSessionAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw invalid("Harness session adapter must be an object");
  if (adapter.contractVersion !== HARNESS_SESSION_CONTRACT_VERSION) throw invalid(`Harness session adapter contractVersion must be ${HARNESS_SESSION_CONTRACT_VERSION}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adapter.id || "")) throw invalid("Harness session adapter id must be a lowercase kebab-case identifier");
  if (typeof adapter.displayName !== "string" || !adapter.displayName.trim() || adapter.displayName.length > 80) throw invalid("Harness session adapter displayName must be 1 to 80 characters");
  const capabilities = normalizedCapabilities(adapter.capabilities);
  for (const capability of requiredCapabilities) {
    if (!capabilities.includes(capability)) throw invalid(`Harness session adapter is missing required capability: ${capability}`);
  }
  for (const [capability, method] of capabilityMethods) {
    const declared = capabilities.includes(capability);
    if (declared && typeof adapter[method] !== "function") throw invalid(`${capability} requires ${method}()`);
    if (!declared && typeof adapter[method] === "function") throw invalid(`${method}() must not be exposed without ${capability}`);
  }
  if (
    capabilities.includes(HARNESS_SESSION_CAPABILITIES.INTERACTIVE_QUESTIONS)
    && typeof adapter.answerQuestion !== "function"
  ) throw invalid(`${HARNESS_SESSION_CAPABILITIES.INTERACTIVE_QUESTIONS} requires answerQuestion()`);
  if (
    !capabilities.includes(HARNESS_SESSION_CAPABILITIES.INTERACTIVE_QUESTIONS)
    && typeof adapter.answerQuestion === "function"
  ) throw invalid(`answerQuestion() must not be exposed without ${HARNESS_SESSION_CAPABILITIES.INTERACTIVE_QUESTIONS}`);
  return adapter;
}

export function harnessSessionAdapterInfo(adapter) {
  validateHarnessSessionAdapter(adapter);
  return {
    contractVersion: adapter.contractVersion,
    id: adapter.id,
    displayName: adapter.displayName.trim(),
    capabilities: normalizedCapabilities(adapter.capabilities),
  };
}

export function supportsHarnessSessionCapability(adapterOrInfo, capability) {
  return knownCapabilities.has(capability) && Array.isArray(adapterOrInfo?.capabilities) && adapterOrInfo.capabilities.includes(capability);
}
