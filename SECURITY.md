# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** feature. If private vulnerability reporting is not yet enabled, contact the maintainer privately and ask for a secure reporting channel before sending technical details. Do not open a public issue containing an exploit, credential, cookie, private page content, session token, or sensitive browser artifact.

Include the affected version or commit, operating system, Chrome version, impact, minimal reproduction steps, and whether you believe a credential or private browser state was exposed. Use synthetic accounts and redacted artifacts whenever possible. Maintainers should acknowledge a report within seven days, provide a status update within fourteen days, and coordinate disclosure after a fix or mitigation is available. These are targets, not a warranty.

The latest release and the current default branch receive security fixes. Older versions may be asked to upgrade before a fix is backported.

## Security boundary

The bridge is intended for local, user-present automation. It is not a remote browser-control service and must not be exposed beyond the loopback interface.

The long-lived bearer token in `~/.chrome-agent-bridge/auth.json` grants control through the local bridge. With Raw CDP enabled, that includes arbitrary developer-protocol commands that may read credentials, cookies, storage, page contents, request or response bodies, and other sensitive browser data. Keep the file private, never commit or log the token or Raw results containing secrets, and use **Renew** in the extension popup immediately if the token may have been disclosed. Renewal invalidates the previous token.

Never bind the RPC server beyond `127.0.0.1`, forward its port, place it behind a public proxy, or share its bearer token. Raw CDP is designed for a user-present local Agent operating an explicitly selected tab, not unattended or remote browser administration.

Debugger scopes, evaluated values, script sources, request headers, bodies, HAR exports, authentication findings, traces, and heap snapshots may contain private data or live credentials. Raw-backed analysis keeps bounded state in the local MCP process until `browser_cdp_detach`; detaching clears that cache. Artifact tools write user-only files under `~/.chrome-agent-bridge/artifacts/`, which the user or Agent must remove when no longer needed.

`network_export_har` and `network_extract_auth` require explicit confirmation. Do not weaken or bypass those checks. `network_intercept` can pause live requests; always disable it and detach Raw in cleanup paths.

## Repository hygiene

Run `npm run audit:public` before every public push or release. It checks the current tree and complete Git history for credential-shaped values, private-key material, and forbidden credential files, and checks the current tree for developer-specific absolute paths, without printing matched content. Run `npm audit --omit=dev --audit-level=high` as the dependency gate.

If any credential is committed, assume it is compromised even after deleting the file: revoke or rotate it first, then remove it from the repository and its Git history before making the repository public. Do not paste a replacement credential into an issue, pull request, commit message, test fixture, evaluation result, or chat transcript.
