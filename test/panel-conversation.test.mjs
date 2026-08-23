import assert from "node:assert/strict";
import test from "node:test";
import { formatPanelConversation, panelHistoryFromTranscript } from "../lib/panel-conversation.mjs";

test("empty history is a stable none token", () => {
  assert.equal(formatPanelConversation([]), "(none)");
  assert.equal(formatPanelConversation(undefined), "(none)");
});

test("history excludes the current message and keeps listing titles", () => {
  const history = panelHistoryFromTranscript([
    { id: "panel_1", role: "user", text: "recommend a 27B GPU box" },
    { id: "panel_2", role: "agent", text: "Mid-tier RTX 4070 laptops", links: [{ title: "ASUS TUF 4070", url: "https://www.amazon.com/dp/B0A" }] },
    { id: "panel_3", role: "user", text: "give me the links" },
  ], "panel_3");
  assert.equal(history.length, 2);
  assert.deepEqual(history[1].titles, ["ASUS TUF 4070"]);
  const conversation = formatPanelConversation(history);
  assert.match(conversation, /User: recommend a 27B GPU box/);
  assert.match(conversation, /\[cards: ASUS TUF 4070\]/);
  assert.doesNotMatch(conversation, /give me the links/);
});
