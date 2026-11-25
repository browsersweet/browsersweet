# Contributing

Thanks for helping with Browser Sweet's packages. This repository is an [Nx](https://nx.dev) workspace managed with pnpm; each published package lives under `packages/`.

## Set up

You need Node.js 24 (`.nvmrc`; `nvm use` picks it up) and pnpm, which [Corepack](https://nodejs.org/api/corepack.html) provides at the version in `package.json`:

```sh
corepack enable
pnpm install
```

Run tasks through Nx, from the repository root:

```sh
pnpm exec nx run-many -t lint typecheck test build   # everything CI runs per project
pnpm exec nx test browsersweet-mcp                   # one project (builds first)
pnpm exec nx format:write                            # Prettier
```

The published packages themselves support Node 22 and newer (their `engines`); 24 is only for working on the repository.

## Before you open a pull request

CI (`.github/workflows/ci.yml`) runs these, and a pull request needs them to pass:

- `pnpm exec nx format:check --all`
- `pnpm exec nx run megamono:check` (workspace structure and package sources; it rejects local package links such as yalc or `file:`)
- `pnpm exec nx run-many -t lint typecheck test build`
- for `@browsersweet/mcp`, installing the packed tarball and starting the MCP server on Node 22, 24 and 26

Also:

- **Add a changelog entry** for user-facing changes to the package's `CHANGELOG.md`, under a `## Unreleased` heading at the top. It's renamed to the version when the release is cut.
- **Keep dependencies small.** `@browsersweet/mcp` may only depend on `@modelcontextprotocol/sdk`, `zod` and `tslib`; `src/package.spec.ts` enforces it. Raise new runtime dependencies in an issue first.
- **Protocol changes** go in `packages/mcp/PROTOCOL.md` too, and should stay compatible with older peers (see its compatibility notes).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat(mcp): …`, `fix(mcp): …`, `docs: …`).

## Releases

Maintainers release from GitHub Actions with the **Release packages** workflow (`.github/workflows/megamono-release.yml`). Every package under `packages/` is released together on one version, one `v<version>` tag and one GitHub release; private packages are never published.

1. Rename each changed package's `## Unreleased` heading to `## <version>` and merge that to `main`.
2. Run **Release packages** with `dry_run` on and check the log.
3. Run it again with `dry_run` off. `publish-current` publishes the version already in the `package.json` files (the first release, or a retry); `bump-and-publish` runs `nx release version` (`patch`, `minor`, `major`, `prerelease`…), pushes the version commit and tag, then publishes.

A real release runs from the default branch only and stops before pushing anything if no package changelog has an entry for the version. The changelog entries become the GitHub release notes. npm publishing uses trusted publishing (or an `NPM_TOKEN` secret for a package's first release), with provenance.
