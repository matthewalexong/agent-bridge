# Project lineage and modifications

Agent Bridge is derived from [Chrome Agent Bridge](https://github.com/escapeWu/chrome-agent-bridge), created by 梧桐 (`escapeWu`) and distributed under the MIT License. The original copyright notice and license text are preserved in [LICENSE](./LICENSE).

This repository's contributors have extended and repositioned that foundation as a domain-neutral bridge between AI harnesses and the Chrome browser a user already uses. Material additions include:

- a harness-connected Chrome side panel with durable, resumable sessions;
- clearer activity, session naming, history, and recovery behavior;
- general browser-control and analysis integrations;
- an evidence-driven shopping capability used as the first reference workflow;
- shopping research, price and availability evidence, value-tier, merchant-trust, counterfeit-risk, and evaluation systems; and
- additional tests, policies, documentation, and token-efficiency work.

The modified project is maintained independently. References to the upstream project identify its origin and do not imply endorsement of this fork.

## Compatibility identifiers

Some internal names intentionally remain unchanged so upgrades do not break existing users. These include the `chrome-agent-bridge` MCP and plugin identifiers, native-messaging host identifiers, environment variables, release artifact prefix, extension ID, and the `~/.chrome-agent-bridge/` local state directory. Public-facing product text uses **Agent Bridge**.

Additional dependency, reference-project, and clean-room implementation notices are recorded in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
