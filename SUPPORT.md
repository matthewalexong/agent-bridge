# Support

Agent Bridge is an early developer beta. Community support is best-effort.

## Installation and usage questions

Start with the [ten-minute quick start](./docs/quick-start.md), run `npm run doctor`, then consult the [Agent installation guide](./docs/agent-installation.md) and [architecture guide](./docs/architecture.md). If the answer is not there, start a GitHub Discussion with your operating system, Chrome version, Node.js version, harness type, and the first diagnostic check that failed.

Never include pairing tokens, cookies, headers, request or response bodies, private URLs, account information, or unredacted browser captures.

For a machine-readable diagnostic, run `npm --silent run doctor -- --json`. The output intentionally omits the pairing token, private browser content, absolute home path, local port, and process ID, but you should still review it before posting.

## Reproducible bugs

Use the bug-report form. Include a minimal synthetic reproduction, whether the extension was reloaded or native host reinstalled, and the smallest relevant sanitized log excerpt. A report should describe observed behavior without revealing private page content.

## Response-quality feedback

Use the response-quality form when the connection worked but the harness misunderstood intent, researched too narrowly, cited weak evidence, omitted useful alternatives, reported confusing progress, or proposed an unsafe action. Shopping is welcome, but the form supports every browser workflow.

## Security vulnerabilities

Do not open a public issue. Follow [SECURITY.md](./SECURITY.md).
