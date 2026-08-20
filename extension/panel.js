// Side panel chat surface. The connected agent is the brain — the panel is a
// dumb transport: user text rides the bridge event stream to the agent, and
// agent replies arrive via panel.post. No model logic lives here.

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.ok !== true) {
        reject(new Error(response?.error?.message || "Panel request failed"));
        return;
      }
      resolve(response.result);
    });
  });
}

function roleLabel(role) {
  if (role === "user") return "You";
  if (role === "agent") return "Agent";
  return "System";
}

function renderEntry(doc, transcript, entry) {
  const bubble = doc.createElement("div");
  bubble.className = `msg ${entry.role}`;
  const who = doc.createElement("span");
  who.className = "who";
  who.textContent = roleLabel(entry.role);
  const body = doc.createElement("span");
  body.className = "body";
  body.textContent = entry.text;
  bubble.append(who, body);
  transcript.append(bubble);
}

function renderAll(doc, transcript, entries) {
  transcript.querySelectorAll(".msg").forEach((node) => node.remove());
  const empty = doc.querySelector("#empty");
  if (empty) empty.hidden = entries.length > 0;
  for (const entry of entries) renderEntry(doc, transcript, entry);
  transcript.scrollTop = transcript.scrollHeight;
}

export function startPanel(doc = document) {
  const transcript = doc.querySelector("#transcript");
  const status = doc.querySelector("#status");
  const form = doc.querySelector("#composer");
  const input = doc.querySelector("#input");
  const sendButton = doc.querySelector("#send");
  const clearButton = doc.querySelector("#clear");

  let connected = false;

  function setBridgeState(ok) {
    connected = ok;
    if (ok) {
      status.textContent = "Bridge connected — waiting for your agent";
      status.className = "status connected";
    } else {
      status.textContent = "Local bridge unavailable";
      status.className = "status error";
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "panel.update") {
      renderAll(doc, transcript, message.transcript ?? []);
    }
  });

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!sendButton.disabled) form.requestSubmit();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !connected) return;
    sendButton.disabled = true;
    try {
      await send({ type: "panel.send", text });
      input.value = "";
      autosize();
      status.textContent = "Sent — your agent will reply here";
      status.className = "status waiting";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = "status error";
    } finally {
      sendButton.disabled = !connected;
      input.focus();
    }
  });

  clearButton.addEventListener("click", async () => {
    try {
      await send({ type: "panel.clear" });
    } catch {
      // Clearing is best-effort; the transcript broadcast keeps the UI honest.
    }
  });

  // Hydrate: existing transcript plus bridge connectivity in parallel.
  send({ type: "panel.get" })
    .then((result) => renderAll(doc, transcript, result.transcript ?? []))
    .catch(() => {});
  send({ type: "auth.get" })
    .then(() => {
      setBridgeState(true);
      sendButton.disabled = false;
    })
    .catch(() => {
      setBridgeState(false);
      sendButton.disabled = true;
    });
  input.focus();
}

if (typeof document !== "undefined") startPanel();
