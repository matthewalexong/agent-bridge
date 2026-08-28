## Outcome

Describe the user-visible problem and the result of this change.

## Architectural ownership

Which layer owns this change: Chrome extension, Native Messaging host, MCP, harness adapter/session layer, analysis, domain capability, or contributor tooling? Explain any boundary change.

## Security and privacy

Describe new permissions, sensitive browser data, authentication, Raw CDP, consequential actions, storage, or cleanup implications. Write `None` only after reviewing the trust boundary.

## Verification

List focused tests and manual checks, then confirm the repository gates:

- [ ] Regression tests were added or the change is documentation-only.
- [ ] `npm run audit:public`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `npm run check`
- [ ] `npm run build:extension`
- [ ] Test fixtures and evidence contain no credentials or private browser data.
- [ ] Any required extension reload, native-host reinstall, migration, or compatibility impact is documented.

## Screenshots or traces

Optional. Use synthetic pages and redact private data. Never attach pairing tokens, cookies, headers, request or response bodies, account information, or private browsing content.
