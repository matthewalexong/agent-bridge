import assert from "node:assert/strict";
import test from "node:test";
import { newConversationId, sanitizeConversationId } from "../lib/panel-conversation.mjs";

test("conversation ids are stable webhook session keys", () => {
  assert.equal(sanitizeConversationId("  abc-123  "), "abc-123");
  assert.equal(sanitizeConversationId("bad id!"), "badid");
  assert.equal(sanitizeConversationId(""), null);
  const id = newConversationId();
  assert.match(id, /^c[a-f0-9]{32}$/);
  assert.equal(sanitizeConversationId(id), id);
});
