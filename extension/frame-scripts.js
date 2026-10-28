// Functions injected into page frames with chrome.scripting.executeScript.
// Chrome serializes each function's source, so every helper must live inside
// the function body: nothing here may reference module scope.

// Runs in the parent of a frame that holds an action target. Finds the
// <iframe>/<frame> owner of that child frame, then either maps a point from
// the child's viewport into this frame's viewport ("point") or moves keyboard
// focus into the child ("focus").
export function locateChildFrame(child, x, y, mode) {
  const deepQueryAll = (selector) => {
    let usesShadowDom = false;
    for (const element of document.querySelectorAll("*")) {
      if (element.shadowRoot) {
        usesShadowDom = true;
        break;
      }
    }
    if (!usesShadowDom) return [...document.querySelectorAll(selector)];
    const found = [];
    const visit = (scope) => {
      const matches = new Set(scope.querySelectorAll(selector));
      for (const element of scope.querySelectorAll("*")) {
        if (matches.has(element)) found.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    return found;
  };
  const elementFromPointDeep = (pointX, pointY) => {
    let hit = document.elementFromPoint(pointX, pointY);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(pointX, pointY);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  const owners = deepQueryAll("iframe, frame");
  let owner = null;
  if (Number.isInteger(child?.index) && child.index >= 0 && child.index < window.length) {
    const target = window[child.index];
    owner = owners.find((candidate) => candidate.contentWindow === target) || null;
  }
  if (!owner) {
    // Frames inside shadow roots are missing from window.frames, so fall back
    // to the frame's viewport size (and URL when that is still ambiguous).
    const indexed = new Set();
    for (let index = 0; index < window.length; index += 1) indexed.add(window[index]);
    const sameSize = owners.filter((candidate) => {
      if (!candidate.contentWindow || indexed.has(candidate.contentWindow)) return false;
      const style = getComputedStyle(candidate);
      const width = candidate.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      const height = candidate.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
      return Math.abs(width - child?.width) <= 1 && Math.abs(height - child?.height) <= 1;
    });
    const sameUrl = sameSize.filter((candidate) => candidate.src === child?.href);
    owner = sameUrl.length === 1 ? sameUrl[0] : sameSize.length === 1 ? sameSize[0] : null;
  }
  if (!owner) {
    return { error: { code: "frame_position_unavailable", message: "The frame that holds the action target could not be found. Take a fresh snapshot." } };
  }

  if (mode === "focus") {
    owner.focus({ preventScroll: true });
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return { focused: active === owner };
  }

  // The child's viewport starts at the owner's content box. Scale handles
  // owners drawn with a CSS scale transform; rotation is not supported.
  const measure = () => {
    const rect = owner.getBoundingClientRect();
    const style = getComputedStyle(owner);
    const scaleX = owner.offsetWidth ? rect.width / owner.offsetWidth : 1;
    const scaleY = owner.offsetHeight ? rect.height / owner.offsetHeight : 1;
    return {
      x: rect.left + (owner.clientLeft + parseFloat(style.paddingLeft || "0") + x) * scaleX,
      y: rect.top + (owner.clientTop + parseFloat(style.paddingTop || "0") + y) * scaleY,
    };
  };
  const inViewport = (point) => point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight;
  let point = measure();
  if (!inViewport(point)) {
    owner.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    point = measure();
  }
  if (!inViewport(point)) {
    window.scrollBy({ left: point.x - innerWidth / 2, top: point.y - innerHeight / 2, behavior: "instant" });
    point = measure();
  }
  if (!inViewport(point)) {
    return { error: { code: "element_not_receiving_pointer", message: "The frame that holds the action target is outside the visible page." } };
  }
  if (elementFromPointDeep(point.x, point.y) !== owner) {
    return { error: { code: "element_not_receiving_pointer", message: "Another element covers the frame that holds the action target." } };
  }
  return { x: point.x, y: point.y };
}

// Runs in the frame that holds a prepared press target and reports whether
// that target (or something inside it) has keyboard focus in its document.
export function inspectPreparedFocus(marker) {
  const registered = globalThis.__cabActionTargets?.get(marker);
  const element = document.querySelector(`[data-cab-action-target="${marker}"]`) ||
    (registered?.isConnected && registered.getAttribute("data-cab-action-target") === marker ? registered : null);
  if (!element) return { focused: false, reason: "target_removed" };
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  for (let node = active; node; node = node instanceof ShadowRoot ? node.host : node.parentNode) {
    if (node === element) return { focused: true };
  }
  return { focused: false };
}
