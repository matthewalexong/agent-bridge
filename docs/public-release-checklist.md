# Public release security checklist

Complete this checklist before changing the repository visibility to public or publishing a release.

## Credentials and history

- Run `npm run audit:public` from a clean checkout.
- Confirm `npm run audit:public` completes its full-history scan, then enable the hosting provider's secret scanning as an independent second layer.
- Revoke or rotate every API key, bearer token, webhook secret, or browser-bridge token that has ever appeared in a commit, patch, issue, pull request, evaluation artifact, terminal capture, or chat transcript.
- Treat deletion as cleanup, not revocation. A deleted credential remains compromised until its provider invalidates it.
- Confirm that `~/.chrome-agent-bridge/`, `.dsh/`, local model profiles, browser artifacts, logs, and generated HAR or trace files are not tracked.

## GitHub settings

- Enable private vulnerability reporting.
- Enable secret scanning and push protection when available.
- Require the security workflow and the normal test workflow before merging to the default branch.
- Restrict workflow token permissions to read-only unless a job has a documented reason for more.
- Review collaborators, deploy keys, webhooks, Actions secrets, and branch protection.

## Release contents

- Build the extension ZIP from a clean clone and inspect its file list.
- Confirm the manifest permissions and stable extension ID are expected.
- Confirm the native host listens only on `127.0.0.1` and requires authentication.
- Confirm no logs, evaluation outputs, source maps containing private paths, local configuration, credentials, or browser data are in the ZIP.
- Run `npm audit --omit=dev --audit-level=high` and the complete test suite.

## Disclosure readiness

- Verify that the **Report a vulnerability** path works from a non-maintainer account.
- Ensure [SECURITY.md](../SECURITY.md) matches the enabled reporting channel.
- Prepare a fast revocation path for the bridge bearer token and every hosted model provider used by maintainers.
