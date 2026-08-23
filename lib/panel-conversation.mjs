const MAX_TURNS = 8;
const MAX_TEXT = 240;
const MAX_TOTAL = 2_000;

export function formatPanelConversation(history) {
  if (!Array.isArray(history) || history.length === 0) return "(none)";
  const lines = [];
  for (const entry of history.slice(-MAX_TURNS)) {
    if (!entry || typeof entry !== "object") continue;
    const who = entry.role === "user" ? "User" : "Agent";
    let text = String(entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    const titles = Array.isArray(entry.titles)
      ? entry.titles
      : Array.isArray(entry.links)
        ? entry.links.map((link) => link?.title).filter(Boolean)
        : [];
    const shown = titles.filter((title) => typeof title === "string" && title.trim()).slice(0, 3);
    if (shown.length > 0) text = `${text}${text ? " " : ""}[cards: ${shown.join("; ")}]`;
    if (!text) continue;
    lines.push(`${who}: ${text}`);
  }
  if (lines.length === 0) return "(none)";
  return lines.join("\n").slice(0, MAX_TOTAL);
}

export function panelHistoryFromTranscript(transcript, currentId) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((entry) => entry && entry.id !== currentId)
    .slice(-MAX_TURNS)
    .map((entry) => ({
      role: entry.role,
      text: String(entry.text ?? "").slice(0, MAX_TEXT),
      titles: Array.isArray(entry.links)
        ? entry.links.map((link) => link?.title).filter((title) => typeof title === "string" && title.trim()).slice(0, 3)
        : [],
    }));
}
