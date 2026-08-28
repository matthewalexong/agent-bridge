# Agent Bridge developer beta

Agent Bridge lets compatible local AI harnesses and MCP agents work through the Chrome browser the user already uses, including existing tabs and signed-in sessions. The extension, Native Messaging host, and MCP server run locally. No specific harness, model provider, or local model is required.

## Included

- Semantic page snapshots and short-lived element references.
- Atomic click, fill, key, select, navigation, screenshot, and tab operations.
- Harness-connected side panel with identity, activity, and resumable harness-owned sessions.
- Sanitized request lifecycle monitoring.
- Explicit tab-scoped Raw Chrome DevTools Protocol sessions for advanced work.
- Bounded local JavaScript, binary, protocol, source-map, and WebAssembly analysis.
- Evidence-driven shopping as the first mature domain capability and evaluation suite.

## Developer-beta limitations

- Installation uses Chrome's **Load unpacked** developer flow; this is not a Chrome Web Store release.
- The native host currently supports macOS and Linux. Windows installation is not implemented.
- A compatible MCP harness must install both the MCP server and the paired `chrome-agent-control` Skill.
- Harness adapters vary in session listing, renaming, archiving, and transcript support.
- Raw CDP grants powerful access to the selected tab and requires careful scoping and cleanup.
- Community support and compatibility are best-effort while the integration surface stabilizes.

## Install

Download the extension ZIP and `SHA256SUMS.txt` from the release assets. Verify the checksum, extract the ZIP into a permanent directory, and load that directory from `chrome://extensions` with **Developer mode** enabled. Then follow [the Agent installation guide](https://github.com/matthewalexong/agent-bridge/blob/main/docs/agent-installation.md) for the local host, MCP registration, paired Skill, and connection test.

The release ZIP must contain `manifest.json`, the background service worker, popup files, side-panel files, and four icon sizes at its archive root. It contains no pairing credential or user browser data.

## Safety

The pairing token represents local browser-control authority. Do not paste it into chat, issues, logs, or configuration committed to Git. Review the selected tab and action before allowing consequential operations. Raw CDP may expose cookies, storage, headers, bodies, credentials, and private page content.

Report vulnerabilities privately through [SECURITY.md](https://github.com/matthewalexong/agent-bridge/blob/main/SECURITY.md). Use the repository's response-quality form for sanitized feedback about intent, research breadth, evidence, progress indicators, browser actions, or efficiency.
