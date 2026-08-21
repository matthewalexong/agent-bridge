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
  // Link cards (agent-cited products/pages). URLs are already protocol-
  // filtered to http(s) by the service worker; we still build everything
  // with DOM APIs so no markup can be injected.
  if (Array.isArray(entry.links) && entry.links.length > 0) {
    const cards = doc.createElement("div");
    cards.className = "cards";
    for (const link of entry.links.slice(0, 5)) {
      if (typeof link !== "object" || link === null || typeof link.url !== "string") continue;
      let url;
      try {
        url = new URL(link.url);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const card = doc.createElement("a");
      card.className = "card";
      card.href = url.href;
      card.target = "_blank";
      card.rel = "noopener";
      if (typeof link.image === "string" && /^https?:\/\//i.test(link.image)) {
        const img = doc.createElement("img");
        img.src = link.image;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => img.remove());
        card.append(img);
      }
      const info = doc.createElement("span");
      info.className = "card-info";
      const title = doc.createElement("span");
      title.className = "card-title";
      title.textContent = link.title || url.hostname;
      info.append(title);
      if (typeof link.price === "string" && link.price.trim()) {
        const price = doc.createElement("span");
        price.className = "card-price";
        price.textContent = link.price.trim();
        info.append(price);
      }
      card.append(info);
      cards.append(card);
    }
    if (cards.childElementCount > 0) bubble.append(cards);
  }
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
  let agentName = null;

  function setStatus() {
    if (!connected) {
      status.textContent = "Local bridge unavailable";
      status.className = "status error";
      return;
    }
    if (agentName) {
      status.textContent = `Connected to ${agentName}`;
      status.className = "status connected";
    } else {
      status.textContent = "Bridge connected — waiting for your agent";
      status.className = "status waiting";
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "panel.update") {
      renderAll(doc, transcript, message.transcript ?? []);
      agentName = message.agent?.name ?? null;
      setStatus();
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
      status.textContent = agentName
        ? `Sent to ${agentName} — reply will appear here`
        : "Sent — your agent will reply here";
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

  // Hydrate: existing transcript, agent identity, and bridge connectivity.
  send({ type: "panel.get" })
    .then((result) => {
      renderAll(doc, transcript, result.transcript ?? []);
      agentName = result.agent?.name ?? null;
      setStatus();
      // Stale service worker detection: a cached SW from an older extension
      // load won't report capabilities, and newer features (link cards,
      // identify) would silently degrade. Surface it instead of hiding it.
      if (!Array.isArray(result.capabilities)) {
        const stale = doc.createElement("p");
        stale.className = "empty";
        stale.textContent =
          "Note: this extension is running an older cached service worker — new features (like link cards) may be missing. Reload the extension in chrome://extensions to fix.";
        transcript.append(stale);
      }
    })
    .catch(() => {});
  send({ type: "auth.get" })
    .then(() => {
      connected = true;
      setStatus();
      sendButton.disabled = false;
    })
    .catch(() => {
      connected = false;
      setStatus();
      sendButton.disabled = true;
    });
  input.focus();
}

if (typeof document !== "undefined") startPanel();
