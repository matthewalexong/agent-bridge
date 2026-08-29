# Agent Bridge architecture

Agent Bridge gives a compatible local AI harness controlled access to the Chrome session the user already uses. It does not launch a remote browser, upload a browser profile, or make one model provider part of the bridge.

## Component and ownership map

```text
Connected harness
  owns: main reasoning model, planning, durable conversation, user-facing judgment
            │
            │ MCP tools + paired workflow Skill
            ▼
MCP server
  owns: tool contracts, bounded projections, local analysis, explicit Raw sessions
            │
            │ authenticated loopback RPC
            ▼
Native Messaging host
  owns: local process boundary, bearer-token validation, Chrome message framing
            │
            │ Chrome Native Messaging
            ▼
Chrome extension
  owns: tab-scoped browser actions, semantic refs, debugger attachment, side-panel view
            │
            ▼
User's existing Chrome tabs, cookies, and signed-in sessions
```

The harness is the main brain. Agent Bridge transports capabilities and returns bounded evidence. A harness may choose any appropriate hosted or local model. Optional inexpensive models may handle narrow auxiliary work, but no local model or named provider is required by the architecture.

## Runtime flow

1. The harness starts `mcp/server.mjs` and calls a browser tool.
2. The MCP server reads the local pairing credential and sends authenticated RPC to the loopback host.
3. The native host validates the credential and forwards one framed message to the approved extension ID.
4. The extension scopes the operation to the requested tab and returns a bounded result.
5. The MCP server projects that result into the safe high-level contract or, for an explicitly attached Raw session, returns the requested CDP data.

Side-panel conversation uses the harness's canonical session path. **New session** calls the adapter's native session-create operation, sends the user's text unchanged through the native prompt operation, and automatically projects ordinary assistant messages back into the panel. Agent Bridge does not classify, rewrite, plan, or generate a second response, and the harness model does not need a panel-posting tool.

The loopback host listens only on `127.0.0.1`. The pairing token represents browser-control authority and stays in the local user's private bridge directory.

## Browser authorization

The Chrome extension independently enforces the side panel's **Observe only**, **Ask before acting**, and scope-bounded **Allow routine actions** modes before browser state changes. The harness can request an operation, but it cannot change modes or approve its own pending request through MCP or the native host. Consequential clicks and sensitive monitoring require visible one-time approval even in routine mode. Closing the panel resets browser control to **Ask before acting** and cancels pending actions.

See [browser access controls](./browser-access-controls.md) for the action classes, scopes, approval lifetime, pause behavior, and failure contract.

## Browser-control layers

| Layer | Intended use | Data boundary |
| --- | --- | --- |
| Semantic browser tools | Routine navigation and interaction | Visible structure, short-lived refs, bounded actions |
| Sanitized network tools | Request timing, method, status, and lifecycle | Removes headers, bodies, fragments, credentials, and query strings by default |
| Raw CDP | Explicit advanced debugging or analysis | May expose cookies, storage, bodies, credentials, and private page data |
| Local analyzers | JavaScript, binary, protocol, source-map, and WASM work | Runs without Chrome or browser data unless the caller supplies it |

High-level element refs are invalidated after an action or navigation. The normal interaction loop is `snapshot → one atomic action → new snapshot`. Raw CDP must attach to one selected tab and detach in every cleanup path.

## Session ownership

The connected harness owns durable sessions, titles, transcripts, and reasoning context. The side panel requests a lightweight catalog from the harness and stores only the active session reference for the life of the view. Selecting **New session** must not silently resume hidden context. Loading a prior session returns a display-safe transcript without private reasoning or tool traffic.

Harness adapters are responsible for mapping their own session primitives into the bridge's create, list, load, resume, rename, and recoverable-remove behavior. A provider or harness name shown in the panel is identity metadata, not an architectural dependency.

The versioned capability and privacy requirements are defined in the [harness session adapter contract](./harness-session-adapters.md).

## Domain capabilities

Domain capabilities sit above the neutral browser and session layers:

```text
domain policy and evaluation
        ↓
evidence collection and deterministic checks
        ↓
neutral Agent Bridge browser tools
```

Shopping is the first mature example. Its domain library is dormant on the default live surface while we measure the harness-native baseline. Product identity, market coverage, current availability, landed cost, merchant, counterfeit, safety, and preference checks must not leak into the generic browser protocol as hard-coded product-category behavior. Future controlled experiments may enable explicit domain tools without changing the harness-native conversation baseline.

## Source map

- `extension/` — Manifest V3 extension, side panel, and browser execution boundary.
- `native-host/` — Native Messaging and authenticated loopback bridge.
- `mcp/` — MCP server and tool registration.
- `lib/` — shared browser projections, session adapters, analyzers, and domain logic.
- `skills/` — paired workflow instructions for compatible agents.
- `test/` — deterministic regression and integration tests.
- `eval/` — supplemental model and domain evaluation fixtures.
- `scripts/` — install, packaging, release, and repository-audit utilities.

## Change rules

- Keep the core harness-, model-, and domain-neutral.
- Require explicit user approval before consequential actions such as purchase, submission, publication, deletion, messaging, or permission changes.
- Preserve tab scoping, authentication, bounded outputs, and deterministic cleanup.
- Add a regression test when changing a security boundary, session lifecycle, action contract, or evidence gate.
- Never make the default test suite depend on live credentials, paid inference, a private browser profile, or a third-party site remaining unchanged.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the development workflow and [SECURITY.md](../SECURITY.md) for disclosure and sensitive-data requirements.
