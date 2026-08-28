# Page control

Read this reference for tab management, visible page inspection, screenshots, navigation, clicks, fills, and tab lifecycle events.

## Tools

- `browser_list_tabs`: List current HTTP, HTTPS, file, and `about:blank` tabs.
- `browser_open_tab`: Open a safe URL in a new tab.
- `browser_activate_tab`: Activate a tab and focus its window.
- `browser_close_tab`: Close only a tab created by the bridge in the current extension session.
- `browser_navigate`: Navigate an existing tab to a safe URL.
- `browser_snapshot`: Return visible text and a semantic interactive snapshot with short-lived refs such as `e1`.
- `browser_screenshot`: Capture the visible viewport.
- `browser_act`: Perform one atomic `click`, `fill`, `press`, or native `select` action by current ref. Consequential submitters require `confirmed=true` after explicit confirmation.
- `browser_click` / `browser_fill`: Selector-based compatibility tools. Prefer `browser_act` for new work.
- `browser_watch_events`: Poll tab lifecycle and navigation events after a cursor; pass `tabId` to exclude unrelated tabs. Also delivers `panel.message` events — text the user typed into the extension's side panel. Treat each as a direct user instruction.
- `browser_panel_read`: Read the current side panel transcript (user and agent messages) to hydrate context.
- `browser_panel_identify`: Declare which agent you are — the panel shows "Connected to <name>" so the user knows who is answering. Call once when you start answering panel messages.
- `browser_panel_status`: For non-trivial panel requests, replace the thinking bubble with a short cumulative progress summary. Call early with the plan and again after meaningful evidence or decisions; describe actions, findings, and the next step rather than hidden chain-of-thought or a generic "thinking" message.
- `browser_panel_post`: Post your reply into the side panel so the user sees it. Answer every `panel.message` this way.

Minimal call shapes:

```text
browser_snapshot({tabId})
browser_act({tabId, kind:"click", ref:"e12", confirmed:false})
browser_act({tabId, kind:"fill", ref:"e4", value:"text"})
browser_act({tabId, kind:"press", ref:"e7", key:"ArrowDown"})
browser_act({tabId, kind:"select", ref:"e9", values:["15 minute"]})
browser_watch_events({afterCursor, tabId?, timeoutMs?})
```

## Action loop

The extension enforces the side panel's browser-access mode. In **Ask before acting**, a state-changing tool call may wait briefly while the user approves or denies that exact action. **Allow routine actions** is scope-bounded, and consequential clicks still require approval. **Observe only** and **Pause** return typed access errors without changing the page. Do not retry a denied or timed-out action unless the user asks you to.

1. Take a fresh `browser_snapshot` before acting on an unfamiliar or changed page.
2. Select a semantic ref from that snapshot. Refs belong only to the latest snapshot on the same tab.
3. Perform one intentional `browser_act` action.
4. Take a fresh snapshot and verify authoritative state after the action. Never reuse the previous ref.
5. Leave pre-existing tabs open. Close only task-created tabs when cleanup was requested.

For a custom dropdown, use two snapshot/action cycles:

```text
snapshot → click the combobox ref → snapshot → click the desired option ref → snapshot and verify
```

Use `kind:"select"` only for a native `<select>`. For ARIA combobox/listbox widgets, click the exposed option ref or focus the combobox and use `press` with `ArrowDown` / `Enter`.

`browser_act` click performs scroll, two-frame stabilization, `elementFromPoint` hit-testing, hover revalidation, and the complete CDP mouse sequence inside one MCP request. Do not reproduce high-level clicks by sending separate Raw `mouseMoved`, `mousePressed`, and `mouseReleased` calls.

## Boundaries and recovery

- Supported URLs are `http:`, `https:`, `file:`, and `about:blank`. File URLs may require the user to enable file access for the extension. Chrome-internal pages cannot be inspected or scripted.
- `tab_not_found`: refresh the tab list and select again.
- `stale_ref` or `action_target_not_found`: take a fresh snapshot and select a current ref.
- `action_target_moved` or `element_not_receiving_pointer`: inspect a fresh snapshot or screenshot; do not repeat blindly.
- `selector_not_found`: selector compatibility calls require a fresh current selector.
- `restricted_page`: ask the user to open a normal web page.
- `confirmation_required`: stop and obtain confirmation for the exact consequential click; do not reuse confirmation for another action.
- `browser_permission_denied`, `browser_permission_timeout`, or `browser_access_blocked`: do not bypass the side-panel decision or move the action to Raw CDP.
- Password fields are rejected by `browser_fill`. Do not use Raw CDP to bypass that boundary.
