# Contributing to Agent Bridge

Thank you for helping build a safe, harness-neutral bridge to the Chrome browser people already use. Contributions are welcome across browser control, harness integrations, documentation, evaluation, accessibility, security, and domain capabilities such as the reference shopping workflow.

## Start with the trust boundary

Agent Bridge can operate signed-in tabs and, through Raw CDP, reach private browser state. Never submit real cookies, credentials, tokens, account data, request bodies, private page captures, HAR files, or unredacted logs. Use synthetic accounts and fixtures. Report vulnerabilities through the private process in [SECURITY.md](./SECURITY.md), not a public issue.

The core architecture is deliberately neutral:

- The connected harness owns the main reasoning model and durable conversation context.
- The extension stores only the active view/session reference needed by the open side panel, not a hidden copy of the conversation.
- Local or inexpensive models may assist with narrow, low-risk tasks, but they are optional optimizations rather than architectural dependencies.
- Shopping is the first mature reference capability, not a restriction on the platform.

Read [the architecture guide](./docs/architecture.md) before changing component boundaries, authentication, session ownership, browser permissions, or the Raw CDP surface. Browser-action changes must preserve the [access-control contract](./docs/browser-access-controls.md), and harness integrations must follow the [session adapter contract](./docs/harness-session-adapters.md).

## Choose a contribution lane

- **Browser control:** semantic snapshots, atomic actions, tabs, screenshots, lifecycle events, and sanitized network monitoring.
- **Harness integration:** MCP registration, paired Agent Skills, side-panel identity, progress, and harness-owned session adapters.
- **Analysis:** bounded local analyzers or explicit Raw CDP workflows with reliable cleanup.
- **Domain capability:** evidence and evaluation layers built above the neutral browser bridge. Shopping is the current reference implementation.
- **Contributor experience:** installation, documentation, testing, accessibility, issue triage, and release tooling.

For a substantial behavior change, open a feature request before investing in a large implementation. Small fixes, tests, and documentation corrections can go directly to a pull request.

## Local setup

Requirements:

- Node.js 18 or newer
- Google Chrome on macOS or Linux for live integration work
- Git

```bash
git clone https://github.com/matthewalexong/agent-bridge.git
cd agent-bridge
npm ci
npm run check
```

The complete test suite is deterministic and does not require access to another contributor's browser profile. Tests that exercise the panel and native bridge use local fixtures and isolated processes.

To build the load-unpacked Chrome extension:

```bash
npm run build:extension
```

To connect a development checkout to Chrome, follow [the Agent installation guide](./docs/agent-installation.md). Installing the native host changes local Chrome registration, so it is not part of the default test setup.

## Development workflow

1. Create a focused branch from current `main`.
2. Add or update a regression test for behavior changes.
3. Keep browser-facing results bounded and redact sensitive values by construction.
4. Run the relevant focused test while iterating.
5. Run every required gate before opening a pull request:

```bash
npm run audit:public
npm audit --omit=dev --audit-level=high
npm run check
npm run build:extension
```

`npm run audit:public` scans the current tree and complete Git history without printing matched credentials. If it reports a credential, revoke it before rewriting history or asking for review.

## Tests and fixtures

- Put deterministic tests in `test/*.test.mjs` using Node's built-in test runner.
- Prefer synthetic HTML, request metadata, products, accounts, and identifiers.
- Never make the normal test suite depend on a paid model, live retailer, private browser profile, or maintainer credential.
- Treat live evaluation as supplemental evidence, not a replacement for deterministic regression coverage.
- Preserve exact model, product, offer, source, and session scope where a decision depends on it.

## Pull requests

Keep pull requests reviewable and explain:

- the user-visible problem and intended outcome;
- which architectural component owns the change;
- security or privacy implications;
- tests added and commands run;
- any required extension reload, native-host reinstall, or migration.

Do not mix unrelated cleanup with a functional change. Maintainers may ask to split a change when its security boundary or review surface is too broad.

By contributing, you agree that your contribution is licensed under the repository's MIT License and that you will follow [the Code of Conduct](./CODE_OF_CONDUCT.md).
