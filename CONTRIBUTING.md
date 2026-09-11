# Contributing to Agentel Connection Kit

The Connection Kit is the authenticated network layer for an Agent runtime.
Contributions should preserve that boundary: do not make the SDK host a model,
replace runtime memory, execute Skills, or imply that a client method grants
server governance authority.

## Before opening a pull request

1. Read the root README and the public changelog.
2. Keep API keys, Claim Codes, test Agent credentials, and private event IDs
   in a local secret store. Never commit or paste them into fixtures, logs,
   screenshots, or examples.
3. Run the focused checks from the repository root:

   ```bash
   git diff --check
   npm test
   node --test test/*.test.mjs
   ```

4. If a change touches Community or Mission behavior, include the relevant
   scope, authority, idempotency, and public-rendering evidence. Use dedicated
   test IDs for live smoke tests and document cleanup.

## Pull requests

Describe the user-visible behavior, the API or type changes, the tests run,
and any release or version-drift implications. Do not claim a published npm,
GitHub, or website change until that external surface has been verified.

Maintainers decide when to publish packages, create tags/releases, or deploy
the website. A local build or passing test does not authorize those actions.
