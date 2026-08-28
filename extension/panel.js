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

function appendResearchItems(doc, container, items) {
  const list = doc.createElement("ol");
  list.className = "research-list";
  for (const item of items) {
    const row = doc.createElement("li");
    const heading = doc.createElement("div");
    heading.className = "research-heading";
    const phase = doc.createElement("span");
    phase.className = "research-phase";
    phase.textContent = String(item.phase || "working").replace(/_/g, " ");
    const summary = doc.createElement("span");
    summary.textContent = item.summary || item.text || "Progress update";
    heading.append(phase, summary);
    row.append(heading);
    if (Array.isArray(item.evidence) && item.evidence.length > 0) {
      const evidence = doc.createElement("ul");
      evidence.className = "research-evidence";
      for (const fact of item.evidence) {
        const factRow = doc.createElement("li");
        factRow.textContent = fact;
        evidence.append(factRow);
      }
      row.append(evidence);
    }
    if (item.next) {
      const next = doc.createElement("div");
      next.className = "research-next";
      next.textContent = `Next: ${item.next}`;
      row.append(next);
    }
    list.append(row);
  }
  container.append(list);
}

function appendResearchTrail(doc, bubble, research) {
  if (!Array.isArray(research) || research.length === 0) return;
  const details = doc.createElement("details");
  details.className = "research-trail";
  const summary = doc.createElement("summary");
  summary.textContent = `Research trail · ${research.length} update${research.length === 1 ? "" : "s"}`;
  details.append(summary);
  appendResearchItems(doc, details, research);
  bubble.append(details);
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
  appendResearchTrail(doc, bubble, entry.research);
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
      if (["Verified pick", "Verified offer"].includes(link.verification)) {
        const verified = doc.createElement("span");
        verified.className = "card-verified";
        verified.textContent = `✓ ${link.verification}`;
        info.append(verified);
      }
      const title = doc.createElement("span");
      title.className = "card-title";
      title.textContent = link.title || url.hostname;
      info.append(title);
      if (typeof link.price === "string" && link.price.trim()) {
        const priceRow = doc.createElement("span");
        priceRow.className = "card-price-row";
        if (link.price_label === "Item price") {
          const priceLabel = doc.createElement("span");
          priceLabel.className = "card-price-label";
          priceLabel.textContent = "Item price";
          priceRow.append(priceLabel);
        }
        const price = doc.createElement("span");
        price.className = "card-price";
        price.textContent = link.price.trim();
        priceRow.append(price);
        info.append(priceRow);
      }
      if (typeof link.landed_total === "string" && link.landed_total.trim()) {
        const total = doc.createElement("span");
        total.className = "card-landed-total";
        const label = doc.createElement("span");
        label.textContent = link.landed_total_label === "Estimated landed range" ? "Estimated landed range" : "Landed total";
        const amount = doc.createElement("strong");
        amount.textContent = link.landed_total.trim();
        total.append(label, amount);
        info.append(total);
      }
      if (Array.isArray(link.cost_breakdown) && link.cost_breakdown.length > 0) {
        const breakdown = doc.createElement("span");
        breakdown.className = "card-breakdown";
        for (const item of link.cost_breakdown.slice(0, 9)) {
          if (!item || typeof item.label !== "string" || typeof item.amount !== "string") continue;
          const component = doc.createElement("span");
          const label = doc.createElement("span");
          label.textContent = item.label;
          const amount = doc.createElement("strong");
          amount.textContent = item.amount;
          component.append(label, amount);
          breakdown.append(component);
        }
        if (breakdown.childElementCount > 0) info.append(breakdown);
      }
      if (link.deal_label || link.timing_label) {
        const deal = doc.createElement("span");
        deal.className = "card-deal";
        if (typeof link.deal_label === "string") {
          const quality = doc.createElement("span");
          quality.className = "card-deal-quality";
          quality.textContent = link.deal_label;
          deal.append(quality);
        }
        if (typeof link.timing_label === "string") {
          const timing = doc.createElement("span");
          timing.className = `card-timing ${["Wait", "Monitor price"].includes(link.timing_label) ? "is-wait" : "is-buy"}`;
          timing.textContent = link.timing_label;
          deal.append(timing);
        }
        info.append(deal);
      }
      if (typeof link.history_context === "string" && link.history_context.trim()) {
        const history = doc.createElement("span");
        history.className = "card-history";
        history.textContent = link.history_context.trim();
        info.append(history);
      }
      if (Array.isArray(link.deal_flags) && link.deal_flags.length > 0) {
        const flags = doc.createElement("span");
        flags.className = "card-deal-flags";
        flags.textContent = link.deal_flags.join(" · ");
        info.append(flags);
      }
      if ((typeof link.seller === "string" && link.seller.trim()) || typeof link.availability === "string") {
        const meta = doc.createElement("span");
        meta.className = "card-meta";
        if (typeof link.seller === "string" && link.seller.trim()) {
          const seller = doc.createElement("span");
          seller.className = "card-seller";
          seller.textContent = `Sold by ${link.seller.trim()}`;
          meta.append(seller);
        }
        if (["In stock", "Out of stock", "Availability unknown"].includes(link.availability)) {
          const availability = doc.createElement("span");
          availability.className = `card-availability ${link.availability === "In stock" ? "is-in" : link.availability === "Out of stock" ? "is-out" : "is-unknown"}`;
          availability.textContent = link.availability;
          meta.append(availability);
        }
        if (meta.childElementCount > 0) info.append(meta);
      }
      if (typeof link.delivery === "string" && link.delivery.trim()) {
        const delivery = doc.createElement("span");
        delivery.className = "card-delivery";
        delivery.textContent = link.delivery.trim();
        info.append(delivery);
      }
      const chips = [...(Array.isArray(link.protections) ? link.protections : []), ...(Array.isArray(link.checks) ? link.checks : [])];
      if (chips.length > 0) {
        const details = doc.createElement("span");
        details.className = "card-details";
        for (const value of chips.slice(0, 6)) {
          if (typeof value !== "string" || !value.trim()) continue;
          const chip = doc.createElement("span");
          chip.textContent = value.trim();
          details.append(chip);
        }
        if (details.childElementCount > 0) info.append(details);
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

function renderSessions(select, renameButton, removeButton, sessions, selectedSessionId, sessionAdapter = null) {
  const selected = selectedSessionId || "";
  select.replaceChildren();
  const doc = select.ownerDocument;
  const fresh = doc.createElement("option");
  fresh.value = "";
  fresh.textContent = "New session";
  select.append(fresh);
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const option = doc.createElement("option");
    option.value = session.id;
    const date = new Date(session.updatedAt);
    const when = Number.isNaN(date.valueOf()) ? "" : ` · ${date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    option.textContent = `${session.title || "Previous session"}${when}${session.running ? " · active" : ""}`;
    select.append(option);
  }
  select.value = selected;
  const selectedSession = (Array.isArray(sessions) ? sessions : []).find((session) => session.id === selected);
  const declared = Array.isArray(sessionAdapter?.capabilities) ? sessionAdapter.capabilities : null;
  const canRename = declared == null || declared.includes("sessions.rename:v1");
  const canArchive = declared == null || declared.includes("sessions.archive:v1");
  renameButton.hidden = !canRename;
  removeButton.hidden = !canArchive;
  renameButton.disabled = !canRename || !selectedSession;
  removeButton.disabled = !canArchive || !selectedSession || Boolean(selectedSession.running);
  removeButton.title = selectedSession?.running ? "Active sessions cannot be removed" : "Remove selected session";
}

function renderBrowserAccess(elements, access = {}) {
  const mode = ["observe", "ask", "routine"].includes(access.mode) ? access.mode : "ask";
  const scope = ["tab", "site", "browser"].includes(access.scope) ? access.scope : "tab";
  elements.mode.value = mode;
  elements.scope.value = scope;
  elements.scopeRow.hidden = mode !== "routine";
  elements.pause.setAttribute("aria-pressed", access.paused ? "true" : "false");
  elements.pause.textContent = access.paused ? "Resume" : "Pause";
  if (access.paused) {
    elements.description.textContent = "Browser control is paused. Reading and conversation remain available.";
  } else if (mode === "observe") {
    elements.description.textContent = "The agent can read and research, but cannot change browser state.";
  } else if (mode === "ask") {
    elements.description.textContent = "The agent must ask before clicking, typing, navigating, or monitoring.";
  } else {
    const label = scope === "browser" ? "all tabs" : scope === "site" ? (access.origin || "the current site") : `tab ${access.tabId ?? "currently active"}`;
    elements.description.textContent = `Routine actions are allowed on ${label}. Consequential and sensitive actions still require approval.`;
  }
  const request = Array.isArray(access.pending) ? access.pending[0] : null;
  elements.request.hidden = !request;
  elements.approve.dataset.requestId = request?.id || "";
  elements.deny.dataset.requestId = request?.id || "";
  if (request) {
    elements.requestTitle.textContent = request.risk === "consequential" ? "Consequential action requested" : request.risk === "sensitive" ? "Sensitive access requested" : "Browser action requested";
    elements.requestDetail.textContent = `${request.summary}${request.origin ? ` · ${request.origin}` : ""}`;
  } else {
    elements.requestDetail.textContent = "";
  }
}

// Live "thinking" bubble. Transient — not part of the transcript; it exists
// only while the agent is actively working and is removed when it clears.
// Kept OUTSIDE the transcript rebuild so renderAll() doesn't wipe it mid-turn.
let thinkingBubble = null;
function setThinking(doc, transcript, status, progress = []) {
  const text = status?.text ?? status;
  // Defensive compatibility with an older cached service worker that may have
  // persisted a completed decision as a status. Only unfinished decision
  // updates are busy; a terminal decision is retained in the research trail.
  const terminalDecision = status && typeof status === "object" && status.phase === "decision" && !status.next;
  if (!terminalDecision && text && String(text).trim()) {
    if (!thinkingBubble || !thinkingBubble.isConnected) {
      thinkingBubble = doc.createElement("div");
      thinkingBubble.className = "msg agent thinking";
      thinkingBubble.setAttribute("aria-busy", "true");
      thinkingBubble.setAttribute("aria-live", "polite");
      const head = doc.createElement("div");
      head.className = "thinking-head";
      const who = doc.createElement("span");
      who.className = "who";
      who.textContent = roleLabel("agent");
      const spinner = doc.createElement("span");
      spinner.className = "thinking-spinner";
      spinner.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i += 1) spinner.append(doc.createElement("i"));
      head.append(who, spinner);
      const body = doc.createElement("span");
      body.className = "body";
      thinkingBubble.append(head, body);
      transcript.append(thinkingBubble);
    }
    const body = thinkingBubble.querySelector(".body");
    body.replaceChildren();
    if (Array.isArray(progress) && progress.length > 0) appendResearchItems(doc, body, progress);
    else body.textContent = String(text);
    transcript.scrollTop = transcript.scrollHeight;
  } else if (thinkingBubble && thinkingBubble.isConnected) {
    thinkingBubble.remove();
    thinkingBubble = null;
  }
}

export function startPanel(doc = document) {
  // This long-lived port scopes Hermes context to this side-panel document.
  // Disconnect means the panel closed; the service worker allows a short
  // reconnect grace period so an ordinary document reload keeps its session.
  const lifecyclePort = chrome.runtime.connect({ name: "agent-bridge-panel-lifecycle" });
  const transcript = doc.querySelector("#transcript");
  const status = doc.querySelector("#status");
  const form = doc.querySelector("#composer");
  const input = doc.querySelector("#input");
  const sendButton = doc.querySelector("#send");
  const clearButton = doc.querySelector("#clear");
  const sessionsSelect = doc.querySelector("#sessions");
  const refreshSessionsButton = doc.querySelector("#refresh-sessions");
  const renameSessionButton = doc.querySelector("#rename-session");
  const removeSessionButton = doc.querySelector("#remove-session");
  const accessElements = {
    mode: doc.querySelector("#access-mode"),
    scope: doc.querySelector("#access-scope"),
    scopeRow: doc.querySelector("#access-scope-row"),
    pause: doc.querySelector("#pause-access"),
    description: doc.querySelector("#access-description"),
    request: doc.querySelector("#access-request"),
    requestTitle: doc.querySelector("#access-request-title"),
    requestDetail: doc.querySelector("#access-request-detail"),
    approve: doc.querySelector("#approve-access"),
    deny: doc.querySelector("#deny-access"),
  };

  let connected = false;
  let agentName = null;
  let harnessName = null;

  function setStatus() {
    if (!connected) {
      status.textContent = "Local bridge unavailable";
      status.className = "status error";
      return;
    }
    const connectedName = agentName || harnessName;
    if (connectedName) {
      status.textContent = `Connected to ${connectedName}`;
      status.className = "status connected";
    } else {
      status.textContent = "Bridge connected — waiting for your agent";
      status.className = "status waiting";
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "panel.update") {
      renderAll(doc, transcript, message.transcript ?? []);
      setThinking(doc, transcript, message.status ?? null, message.progress ?? []);
      agentName = message.agent?.name ?? null;
      harnessName = message.sessionAdapter?.displayName ?? null;
      renderSessions(sessionsSelect, renameSessionButton, removeSessionButton, message.sessions ?? [], message.selectedSessionId ?? null, message.sessionAdapter ?? null);
      renderBrowserAccess(accessElements, message.browserAccess);
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
      const connectedName = agentName || harnessName;
      status.textContent = connectedName
        ? `Sent to ${connectedName} — reply will appear here`
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
  accessElements.mode.addEventListener("change", async () => {
    accessElements.mode.disabled = true;
    try {
      const result = await send({ type: "panel.permission.set", mode: accessElements.mode.value, scope: accessElements.scope.value });
      renderBrowserAccess(accessElements, result);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = "status error";
    } finally {
      accessElements.mode.disabled = false;
    }
  });
  accessElements.scope.addEventListener("change", async () => {
    accessElements.scope.disabled = true;
    try {
      const result = await send({ type: "panel.permission.set", mode: "routine", scope: accessElements.scope.value });
      renderBrowserAccess(accessElements, result);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = "status error";
    } finally {
      accessElements.scope.disabled = false;
    }
  });
  accessElements.pause.addEventListener("click", async () => {
    const paused = accessElements.pause.getAttribute("aria-pressed") !== "true";
    const result = await send({ type: "panel.permission.pause", paused }).catch(() => null);
    if (result) renderBrowserAccess(accessElements, result);
  });
  async function resolveAccess(decision, button) {
    const requestId = button.dataset.requestId;
    if (!requestId) return;
    accessElements.approve.disabled = true;
    accessElements.deny.disabled = true;
    try {
      await send({ type: "panel.permission.resolve", requestId, decision });
    } finally {
      accessElements.approve.disabled = false;
      accessElements.deny.disabled = false;
    }
  }
  accessElements.approve.addEventListener("click", () => { void resolveAccess("approve", accessElements.approve); });
  accessElements.deny.addEventListener("click", () => { void resolveAccess("deny", accessElements.deny); });
  sessionsSelect.addEventListener("change", async () => {
    if (!sessionsSelect.value) {
      await send({ type: "panel.clear" }).catch(() => {});
      return;
    }
    sessionsSelect.disabled = true;
    status.textContent = "Loading session from the connected harness…";
    status.className = "status waiting";
    try {
      await send({ type: "panel.session.select", sessionId: sessionsSelect.value });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = "status error";
    } finally {
      sessionsSelect.disabled = false;
    }
  });
  refreshSessionsButton.addEventListener("click", () => {
    void send({ type: "panel.sessions.refresh" });
  });
  renameSessionButton.addEventListener("click", async () => {
    const session = [...sessionsSelect.options].find((option) => option.value === sessionsSelect.value);
    if (!session || !session.value) return;
    const currentTitle = session.textContent.split(" · ")[0];
    const title = window.prompt("Rename session", currentTitle)?.replace(/\s+/g, " ").trim();
    if (!title || title === currentTitle) return;
    renameSessionButton.disabled = true;
    try {
      await send({ type: "panel.session.rename", sessionId: session.value, title });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = "status error";
      renameSessionButton.disabled = false;
    }
  });
  removeSessionButton.addEventListener("click", async () => {
    const session = [...sessionsSelect.options].find((option) => option.value === sessionsSelect.value);
    if (!session || !session.value) return;
    const confirmed = window.confirm(`Remove “${session.textContent}” from the session list?\n\nIts context will remain archived in the connected harness and can be restored there.`);
    if (!confirmed) return;
    removeSessionButton.disabled = true;
    status.textContent = "Removing session from the list…";
    status.className = "status waiting";
    try {
      await send({ type: "panel.session.remove", sessionId: session.value });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = "status error";
      removeSessionButton.disabled = false;
    }
  });
  // Hydrate: existing transcript, agent identity, and bridge connectivity.
  send({ type: "panel.get" })
    .then((result) => {
      renderAll(doc, transcript, result.transcript ?? []);
      setThinking(doc, transcript, result.status ?? null, result.progress ?? []);
      agentName = result.agent?.name ?? null;
      harnessName = result.sessionAdapter?.displayName ?? null;
      renderSessions(sessionsSelect, renameSessionButton, removeSessionButton, result.sessions ?? [], result.selectedSessionId ?? null, result.sessionAdapter ?? null);
      renderBrowserAccess(accessElements, result.browserAccess);
      setStatus();
      // Stale service worker detection: a cached SW from an older extension
      // load won't report capabilities, and newer features (link cards,
      // identify) would silently degrade. Surface it instead of hiding it.
      if (!Array.isArray(result.capabilities) || !result.capabilities.includes("research-trail:v1")) {
        const stale = doc.createElement("p");
        stale.className = "empty";
        stale.textContent =
          "Note: this extension is running an older cached service worker — research trails or link cards may be missing. Reload the extension in chrome://extensions to fix.";
        transcript.append(stale);
      }
    })
    .catch(() => {});
  void send({ type: "panel.sessions.refresh" });
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
