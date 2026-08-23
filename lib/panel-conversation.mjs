const CONVERSATION_ID_RE = /[^A-Za-z0-9._-]+/g;

export function sanitizeConversationId(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(CONVERSATION_ID_RE, "").slice(0, 80);
  return cleaned || null;
}

export function newConversationId() {
  return `c${crypto.randomUUID().replaceAll("-", "")}`;
}
