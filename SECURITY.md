# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: [**Report a vulnerability**](https://github.com/browsersweet/browsersweet/security/advisories/new) (the repository's Security tab → Advisories → Report a vulnerability).

Include what you found, the version (`npx @browsersweet/mcp --version`), your OS and browser, and steps to reproduce. `npx @browsersweet/mcp doctor` output helps, but check it for paths or names you'd rather not share.

We'll acknowledge the report within a few days, keep you updated while we work on a fix, and credit you in the advisory unless you'd rather we didn't.

## Supported versions

Fixes go into the latest release. While the packages are at 0.x, upgrade to the newest version to get them.

## Scope

`@browsersweet/mcp` runs on your computer and bridges your browser and your AI tools, so these are especially interesting:

- another local user, a website, or another extension reaching the native messaging host, its socket or named pipe, or the MCP server's tool calls;
- discovery or install paths that can be redirected (symlinks, shared temp directories, registry keys);
- tool output that escapes the untrusted-content fencing, or anything that lets page content act as instructions to the agent beyond what the fencing and labeling already disclose.

The trust boundaries are described in the package README under [Privacy and security](./packages/mcp/README.md#privacy-and-security) and [Threat model](./packages/mcp/README.md#threat-model). Same-user processes are trusted by design.
