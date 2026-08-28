# Harness session adapter contract

Agent Bridge keeps durable conversation state in the connected harness. The extension is a view onto that state, not a second conversation database. Harness integrations implement this provider-neutral contract so the side panel can list and resume sessions without knowing which model or session store the harness uses.

## Ownership boundary

| Concern | Owner |
| --- | --- |
| Main reasoning model, planning, and tool choices | Connected harness |
| Durable messages, reasoning context, and session lifecycle | Connected harness |
| Mapping harness-native session APIs into this contract | Harness adapter |
| Active selection and display-safe transcript while the panel is open | Agent Bridge side panel |
| Browser actions and bounded browser evidence | Agent Bridge |

No model provider is required by this contract. A harness may change its main model without changing the extension. Optional small or local models are harness-side optimizations only.

## Contract v1

An adapter exposes metadata plus methods whose names match its declared capabilities:

```js
{
  contractVersion: 1,
  id: "example-harness",
  displayName: "Example Harness",
  capabilities: [
    "sessions.list:v1",
    "sessions.load-display-transcript:v1",
    "sessions.resume:v1",
    "sessions.title-from-prompt:v1",
    "sessions.rename:v1",
    "sessions.archive:v1"
  ],
  listSessions,
  loadSession,
  resumeSession,
  titleFromPrompt,
  renameSession,
  archiveSession
}
```

The adapter ID is a stable lowercase kebab-case identifier. The display name is user-facing identity metadata, not an architectural dependency. Capability values are versioned so a future behavior change can be negotiated explicitly.

### Required capabilities

| Capability | Method | Contract |
| --- | --- | --- |
| `sessions.list:v1` | `listSessions()` | Returns at most 30 lightweight resumable top-level sessions as `{id, title, updatedAt, running}`. It must not include messages, reasoning, tool calls, credentials, or browser data. |
| `sessions.load-display-transcript:v1` | `loadSession(sessionId)` | Returns `{sessionId, transcript, hasMore}`. Transcript entries use `{id, role, text, at}` and contain only user-visible user/assistant text. |
| `sessions.resume:v1` | `resumeSession(sessionId, text)` | Sends the exact next user message to the explicitly selected durable harness session. |
| `sessions.title-from-prompt:v1` | `titleFromPrompt(text, maxLength?)` | Produces the initial concise display title from the first user prompt. It does not classify intent or choose the reasoning model. |

### Optional capabilities

| Capability | Method | Contract |
| --- | --- | --- |
| `sessions.rename:v1` | `renameSession(sessionId, title)` | Changes the durable harness title and returns the acknowledged title. |
| `sessions.archive:v1` | `archiveSession(sessionId)` | Performs a recoverable removal from the picker and returns an explicit archive acknowledgement. It must not be presented as permanent deletion. |
| `sessions.pin:v1` | `pinSession(sessionId, pinned)` | Changes harness-owned pin state when supported. The current panel does not yet expose this control. |

Declaring a capability requires its method, and exposing an optional method requires declaring its capability. Unknown, duplicated, incomplete, or mismatched declarations are rejected by `validateHarnessSessionAdapter()` in `lib/harness-session-contract.mjs`.

## User-visible behavior

- **New session is genuine.** A panel labeled **New session** cannot silently resume an old conversation. Previous context is loaded only after the user selects that session.
- **Context stays with the harness.** Closing the side panel detaches the view. It does not delete or copy the harness-owned conversation.
- **Transcripts are display-safe projections.** Private reasoning, tool requests, tool responses, system events, credentials, and hidden browser data never enter the session catalog or loaded panel transcript.
- **Controls are capability-aware.** Rename and remove controls appear only when the connected adapter advertises them. A malformed advertised descriptor fails closed. A missing descriptor retains temporary compatibility with pre-contract native hosts.
- **Archive is recoverable.** The UI describes removal according to the harness operation actually performed.

## Current compatibility

| Integration | List | Display transcript | Resume | Initial title | Rename | Archive | Pin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek Harness adapter | Yes | Yes | Yes | Yes | Yes | Yes | No |

The DeepSeek implementation lives in `lib/harness-sessions.mjs`. DeepSeek-specific API calls remain inside that adapter; the contract, extension state, and panel controls do not import its session API.

## Adding an adapter

1. Map the harness's durable session API to the normalized shapes above.
2. Keep the list lightweight and project only display-safe user/assistant text when loading.
3. Declare only capabilities the harness can acknowledge reliably.
4. Call `validateHarnessSessionAdapter()` when constructing the adapter.
5. Add deterministic fixtures covering catalog filtering, exact-session resume, display projection, first-prompt title, and every optional capability.
6. Run `node --test test/harness-session-contract.test.mjs` and then `npm run check`.

Conformance tests use synthetic sessions and never require a paid model, live credential, private browser profile, or installed harness.
