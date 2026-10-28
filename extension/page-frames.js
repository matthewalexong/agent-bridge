// Frame-aware snapshot bookkeeping for the service worker. Everything here is
// pure (no chrome.* or DOM access) so it can be unit tested in Node.
//
// snapshotPage runs in every frame of a tab. Each subframe reports `_frame`:
// its index path from the top window (`[2, 0]` = third child of top, then that
// frame's first child; -1 marks a frame missing from `parent.frames`, such as
// an iframe inside a shadow root). Every frame also reports `_childFrames`, the
// visibility of its own iframe owners, so hidden frames can be dropped here.

export const MAX_SNAPSHOT_ELEMENTS = 500;

const ACTION_REF_PATTERN = /^(?:f([1-9]\d*))?e(\d+)$/;

// Main-frame refs keep the original `e12` form; refs inside subframes are
// scoped by the frame's ordinal in the snapshot, for example `f2e5`.
export function parseActionRef(ref) {
  if (typeof ref !== "string") return null;
  const match = ACTION_REF_PATTERN.exec(ref);
  if (!match) return null;
  return { frame: match[1] ? Number(match[1]) : 0, element: Number(match[2]) };
}

export function frameScopedRef(frameOrdinal, ref) {
  return frameOrdinal ? `f${frameOrdinal}${ref}` : ref;
}

export function displayFrameUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${url.pathname}`.slice(0, 180);
    return url.protocol === "about:" ? url.href.slice(0, 40) : `${url.protocol}//…`;
  } catch {
    return "";
  }
}

const pathKey = (path) => path.join(".");

// Parents come before their children, siblings follow window.frames order, and
// frames that could not be indexed (-1) sort after indexed siblings.
export function compareFramePaths(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] < 0 ? Number.POSITIVE_INFINITY : left[index];
    const b = right[index] < 0 ? Number.POSITIVE_INFINITY : right[index];
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

function normalizeInjection(injection) {
  return {
    frameId: Number.isInteger(injection?.frameId) ? injection.frameId : 0,
    documentId: typeof injection?.documentId === "string" ? injection.documentId : undefined,
    result: injection?.result,
  };
}

function usableFrameResult(result) {
  return Boolean(result) && !result.error && Array.isArray(result.elements);
}

// Returns null when the main frame produced no snapshot. Otherwise returns the
// public snapshot plus the ref table and frame table the service worker keeps.
export function mergeFrameSnapshots(injections, { maxChars, maxElements = MAX_SNAPSHOT_ELEMENTS } = {}) {
  const normalized = (Array.isArray(injections) ? injections : []).map(normalizeInjection);
  const main = normalized.find((frame) => frame.frameId === 0 && frame.result);
  if (!main || !usableFrameResult(main.result)) return null;

  const subframes = normalized
    .filter((frame) => frame.frameId !== 0 && usableFrameResult(frame.result) && Array.isArray(frame.result._frame?.path) && frame.result._frame.path.length > 0)
    .map((frame) => ({ ...frame, path: frame.result._frame.path }));

  // Index frames by path. Duplicate paths (several unindexable siblings) are
  // ambiguous and resolve to no parent rather than a guessed one.
  const byPath = new Map([["", { ...main, path: [] }]]);
  const ambiguousPaths = new Set();
  for (const frame of subframes) {
    const key = pathKey(frame.path);
    if (byPath.has(key)) ambiguousPaths.add(key);
    else byPath.set(key, frame);
  }
  for (const key of ambiguousPaths) byPath.delete(key);

  const hiddenCache = new Map();
  const isHidden = (frame) => {
    const key = `${frame.frameId}`;
    if (hiddenCache.has(key)) return hiddenCache.get(key);
    let hidden = false;
    const last = frame.path[frame.path.length - 1];
    const parent = byPath.get(pathKey(frame.path.slice(0, -1)));
    if (parent) {
      const owner = last >= 0 && Array.isArray(parent.result._childFrames)
        ? parent.result._childFrames.find((child) => child?.index === last)
        : null;
      hidden = owner?.visible === false || (parent.frameId !== 0 && isHidden(parent));
    }
    hiddenCache.set(key, hidden);
    return hidden;
  };

  const ordered = subframes
    .filter((frame) => !isHidden(frame))
    .sort((left, right) => compareFramePaths(left.path, right.path) || left.frameId - right.frameId);

  const { _frame: _mainFrame, _childFrames: _mainChildren, ...mainPublic } = main.result;
  const refs = new Map();
  const frames = new Map([[0, { frameId: 0, documentId: main.documentId, path: [] }]]);
  const elements = [];
  const snapshotLines = mainPublic.snapshot ? [mainPublic.snapshot] : [];
  const publicFrames = [];

  for (const element of main.result.elements.slice(0, maxElements)) {
    const { _locator, ...publicElement } = element;
    if (typeof element.ref === "string" && _locator) {
      refs.set(element.ref, { frameId: 0, documentId: main.documentId, locator: _locator });
    }
    elements.push(publicElement);
  }

  const textLimit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY;
  let text = String(mainPublic.text || "");
  let truncated = Boolean(mainPublic.truncated);
  let ordinal = 0;

  for (const frame of subframes) {
    frames.set(frame.frameId, {
      frameId: frame.frameId,
      documentId: frame.documentId,
      path: frame.path,
      index: frame.path[frame.path.length - 1],
      href: frame.result._frame.href,
      width: frame.result._frame.width,
      height: frame.result._frame.height,
    });
  }

  for (const frame of ordered) {
    const remaining = maxElements - elements.length;
    const taken = remaining > 0 ? frame.result.elements.slice(0, remaining) : [];
    const frameText = String(frame.result.text || "");
    const textRoom = textLimit - text.length;
    if (taken.length === 0 && (!frameText.trim() || textRoom <= 0)) continue;

    ordinal += 1;
    const frameName = `f${ordinal}`;
    const url = displayFrameUrl(frame.result.url);
    const title = String(frame.result.title || "").replace(/\s+/g, " ").trim().slice(0, 160);
    frames.get(frame.frameId).ordinal = ordinal;

    const lines = String(frame.result.snapshot || "").split("\n");
    snapshotLines.push(`- iframe${title ? ` "${title.replace(/"/g, '\\"')}"` : ""} [frame=${frameName}]${url ? ` [url=${url}]` : ""}`);
    taken.forEach((element, offset) => {
      const { _locator, ...publicElement } = element;
      const ref = frameScopedRef(ordinal, element.ref);
      if (typeof element.ref === "string" && _locator) {
        refs.set(ref, { frameId: frame.frameId, documentId: frame.documentId, locator: _locator });
      }
      elements.push({ ...publicElement, index: elements.length, ref, frame: frameName });
      const line = lines[offset] || "";
      snapshotLines.push(`  ${line.replace(`[ref=${element.ref}]`, `[ref=${ref}]`)}`);
    });

    if (frameText.trim() && textRoom > 0) {
      const section = `\n\n[frame ${frameName}${url ? ` ${url}` : ""}]\n${frameText}`;
      if (section.length > textRoom) truncated = true;
      text += section.slice(0, textRoom);
    }
    if (frame.result.truncated) truncated = true;
    const frameSummary = { frame: frameName, url, title, elementCount: taken.length };
    if (taken.length < frame.result.elements.length) frameSummary.elementsTruncated = true;
    publicFrames.push(frameSummary);
  }

  const result = {
    ...mainPublic,
    text,
    truncated,
    snapshot: snapshotLines.join("\n"),
    elements,
  };
  if (publicFrames.length) result.frames = publicFrames;
  return { result, refs, frames };
}

// Lists the hops from a frame up to the main frame. Each step names the frame
// to run in (`parent`, null for the main frame) and the child frame to find
// there. Returns null when an ancestor is missing from the snapshot.
export function frameAncestry(frames, frameId) {
  if (!(frames instanceof Map)) return null;
  const byPath = new Map();
  const duplicates = new Set();
  for (const frame of frames.values()) {
    const key = pathKey(frame.path);
    if (byPath.has(key)) duplicates.add(key);
    else byPath.set(key, frame);
  }
  let current = frames.get(frameId);
  if (!current || current.path.length === 0) return null;
  const steps = [];
  while (current.path.length > 0) {
    const parentKey = pathKey(current.path.slice(0, -1));
    const parent = duplicates.has(parentKey) ? null : byPath.get(parentKey);
    if (!parent) return null;
    steps.push({
      parent: parent.frameId === 0 ? null : { frameId: parent.frameId, documentId: parent.documentId },
      child: { index: current.index, href: current.href, width: current.width, height: current.height },
    });
    current = parent;
  }
  return steps;
}
