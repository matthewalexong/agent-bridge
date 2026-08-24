import { verifyShoppingDecisionContext } from "./shopping-decision-context.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

export function createShoppingDecisionContextRegistry({ max_entries = 128, clock = Date.now } = {}) {
  if (!Number.isInteger(max_entries) || max_entries < 1 || max_entries > 1_024) {
    throw coded("Decision-context registry size must be between 1 and 1,024", "shopping_decision_context_registry_invalid");
  }
  const entries = new Map();

  function remember(context, evaluated_at = clock()) {
    if (!verifyShoppingDecisionContext(context, evaluated_at)) {
      throw coded("Only a fresh process-attested decision context can be remembered", "shopping_decision_context_reference_invalid");
    }
    const stored = structuredClone(context);
    entries.delete(stored.context_id);
    entries.set(stored.context_id, stored);
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return { context_id: stored.context_id };
  }

  function resolve(reference, evaluated_at = clock()) {
    const contextId = String(reference?.context_id || "");
    const stored = entries.get(contextId);
    if (!stored) {
      throw coded("Decision-context reference is unknown in this process; resend the signed context or create a new wave", "shopping_decision_context_reference_unknown");
    }
    if (!verifyShoppingDecisionContext(stored, evaluated_at)) {
      entries.delete(contextId);
      throw coded("Decision-context reference is expired or invalid", "shopping_decision_context_reference_expired");
    }
    entries.delete(contextId);
    entries.set(contextId, stored);
    return structuredClone(stored);
  }

  return { remember, resolve };
}
