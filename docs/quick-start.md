# Ten-minute Agent Bridge quick start

This path installs the Agent Bridge developer beta for one local user on macOS or Linux. Chrome requires one visible user approval: loading the extracted extension. The pairing credential stays on the computer and must never be pasted into chat.

## Before you start

You need:

- Google Chrome;
- Node.js 18 or newer;
- Git;
- a local MCP-compatible harness;
- a permanent directory for the checkout and extracted extension.

Windows native-host installation is not implemented yet.

## 1. Install the local bridge

```bash
git clone https://github.com/matthewalexong/agent-bridge.git
cd agent-bridge
npm ci
npm run install-host
```

Keep this checkout in place. The private Native Messaging launcher records its absolute location.

## 2. Load the released extension

1. Download `chrome-agent-bridge-extension-v0.9.0.zip` and `SHA256SUMS.txt` from the [v0.9.0 developer beta](https://github.com/matthewalexong/agent-bridge/releases/tag/v0.9.0).
2. Verify the checksum if your download tool did not do so.
3. Extract the ZIP into a permanent directory.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Choose **Load unpacked** and select the extracted directory.
7. Open the Agent Bridge toolbar popup and confirm that it reports a connected local bridge.

Chrome loads the extracted directory, not the ZIP itself.

## 3. Run the installation doctor

From the repository checkout:

```bash
npm run doctor
```

A ready installation reports nine passing checks. The doctor checks the operating system, Node.js, checkout, Chrome, Native Messaging manifest, launcher, private pairing state, local runtime, and an authenticated extension response. It does not print the pairing token, private browser content, absolute home path, runtime port, or process ID.

For machine-readable output without npm's banner:

```bash
npm --silent run doctor -- --json
```

The JSON is designed to be safe to attach to a public support issue, but review any diagnostic before posting it.

## 4. Connect the harness

Point the harness at the MCP server using the absolute checkout path:

```json
{
  "mcpServers": {
    "chrome-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-bridge/mcp/server.mjs"]
    }
  }
}
```

Install the paired `skills/chrome-agent-control` Skill using the harness's Skill mechanism. A Codex plugin installation registers the MCP server and Skill together; a standalone MCP configuration does not. Restart or reload the harness afterward.

Do not put the pairing token in this configuration when the harness runs as the same local user. The MCP server discovers the private local credential automatically.

## 5. Verify one harmless action

Ask the harness to:

1. call `browser_status` and require `connected: true`;
2. call `browser_list_tabs`;
3. ask which ordinary public tab is in scope;
4. call `browser_snapshot` on that tab;
5. perform one harmless atomic action with a returned ref;
6. take a new snapshot and verify the result.

Do not begin the first test on banking, health, work-admin, private-message, or checkout pages. Never reuse a semantic ref after an action or navigation.

## Troubleshooting decision tree

Run `npm run doctor`, then start with the first failed check:

```text
platform / node / checkout / chrome
  └─ Fix the local prerequisite, then rerun npm ci and the doctor.

native-host-manifest / native-host-launcher
  └─ Run npm run install-host from the permanent checkout, then reload the extension.

pairing
  └─ Open Chrome and reload Agent Bridge. If the popup reports a pairing problem,
     renew the credential from the popup; never copy it into a public report.

runtime
  └─ Keep Chrome open, reload Agent Bridge on chrome://extensions, then rerun the doctor.

connection
  └─ Open the extension popup, confirm the local bridge is connected, and rerun the doctor.

all doctor checks pass, but the harness says offline
  └─ Verify the absolute MCP path, install the paired Skill, and restart the harness.

the bridge connects, but a page action fails
  └─ Confirm the selected tab is an ordinary http(s) page, take a fresh snapshot,
     use one current ref, and verify with another snapshot.
```

If the problem remains, open a [bug report](https://github.com/matthewalexong/agent-bridge/issues/new/choose) and include the sanitized doctor output, versions, and a synthetic reproduction. Security vulnerabilities and exposure of private browser state belong in the repository's private security-reporting channel.
