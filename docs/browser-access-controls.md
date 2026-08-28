# Browser access controls

Agent Bridge enforces browser permissions inside the Chrome extension, after a harness requests an action and before Chrome changes state. The connected model cannot grant itself access by changing a prompt or tool argument.

## Modes

| Mode | Behavior |
| --- | --- |
| **Observe only** | Allows reads such as tab listing, snapshots, screenshots, event polling, and existing-session polling or cleanup. Blocks navigation, clicks, typing, selections, tab changes, and new monitoring sessions. |
| **Ask before acting** | Holds each state-changing browser request until the user approves or denies that exact request in the open side panel. This is the default and the reset state. |
| **Allow routine actions** | Allows ordinary browser actions within the selected scope. Consequential clicks and sensitive monitoring still require one-time approval. |

Routine access can be scoped to the current tab, current site, or all tabs. Current-tab scope follows that tab across navigation. Current-site scope does not authorize navigation to another origin. All-tabs scope is intentionally broad but still does not bypass consequential or sensitive approval.

## Approval lifecycle

1. The extension classifies a requested operation before dispatching it to Chrome.
2. If approval is required, the exact call waits for up to 24 seconds and appears in the side panel with a bounded summary. Fill values and raw parameters are not displayed.
3. **Approve once** continues only that waiting call. It does not mint a reusable permission token.
4. **Deny**, timeout, mode changes, pausing, and side-panel closure cancel the waiting call.
5. The extension resets to **Ask before acting** when the side-panel session closes or the service worker restarts.

An identical concurrent call is rejected while the first is pending, preventing approval floods and accidental double execution.

## Action classes

- **Routine:** opening, closing, activating, or navigating tabs; clicks; fills; key presses; and selections.
- **Consequential:** a high-level click marked as a potentially submitting action after the harness has obtained exact user confirmation. These still require visible side-panel approval in routine mode.
- **Sensitive:** starting sanitized network monitoring or attaching an unrestricted Raw CDP session. Approval grants that monitoring session; polling and cleanup remain available so the bridge cannot strand resources.

Raw CDP remains unrestricted after its separately approved attachment. It must not be used to bypass the user's scope, password-field protection, or confirmation requirements. Purchases, form submission, sending, publishing, deletion, account or permission changes, and acceptance of legal or financial terms always require fresh exact user confirmation in addition to the access-mode check.

## Pause and failure behavior

**Pause** immediately blocks new state-changing browser work and rejects pending approvals. It does not erase the conversation or prevent the harness from explaining its state. Resume restores the selected mode; it does not resurrect cancelled actions.

Missing or malformed permission state fails closed to **Ask before acting**. An action outside a routine scope enters the approval flow; denial, timeout, pause, or a mode change returns a typed error. Read and cleanup operations remain available where needed for diagnosis and deterministic detachment.

## Trust boundary

The side-panel runtime message is the only interface that changes access mode or resolves an approval. These operations are not exposed as MCP tools or native-host dispatch methods. Harnesses can read the current panel state but cannot approve their own browser requests.
