# Liminis Instant

**A maintained, self-hostable fork of [Instant](https://github.com/instantdb/instant).**

Instant is a real-time, offline-first database with relational queries, permissions,
auth, storage and presence. In August 2026 the Instant team
[announced](https://github.com/instantdb/instant/blob/main/client/www/_posts/instant_team_joins_openai.md)
that they are joining OpenAI. Instant Cloud closes on **31 August 2027**, and self-hosting is
the way to keep running. This fork exists so that self-hosted Instant keeps getting fixes
after that.

It is maintained by Liminis, which runs its own production apps on it.
It is not affiliated with or endorsed by the Instant team. "Instant" is used here only to
describe what this is a fork of.

> **Status: early.** The patched server and clients are in production use. The first
> public release is being set up; see [Roadmap](#roadmap).

## How it relates to upstream

- **Upstream comes first.** Every fix here is offered upstream as an issue and a PR. When
  upstream merges a fix, the fork drops its own copy and takes upstream's version.
- **The patch stack stays small and rebased.** Branch `self-hosted-patches` is upstream
  `main` plus a short stack of documented commits, rebased onto each new upstream commit we
  adopt. `git log upstream/main..self-hosted-patches` is the whole difference.
- **Drop-in compatible.** Same database schema, migrations, wire protocol and environment
  variables as upstream. Existing `@instantdb/*` clients work against it unchanged.
  You can go back to the upstream image by switching the image tag.

## What's different from upstream

Based on upstream [`15358ad7`](https://github.com/instantdb/instant/commit/15358ad7) (2026-11-05).

| Fix | Why it matters when self-hosting | Upstream |
|---|---|---|
| **Never orphan a grouped-queue group when a pass dies** | If one invalidation pass died (realistically from an `OutOfMemoryError`), that app's queue was never drained again and grew for the life of the process | [#2930](https://github.com/instantdb/instant/issues/2930), PR [#2936](https://github.com/instantdb/instant/pull/2936) |
| **Fetch each entity once when checking a transaction's permissions** | Entities touched by several ops in one transaction were fetched again for every op | PR [#2934](https://github.com/instantdb/instant/pull/2934) |
| **Don't join an `or` at the start of a group to the previous CTE** | Nested `or`s failed with `ambiguous-column`, and an `or` starting a later top-level namespace could **silently return no rows** | [#2947](https://github.com/instantdb/instant/issues/2947), PR [#2948](https://github.com/instantdb/instant/pull/2948) |
| **Subscribe a permission check only to the fields its rules read** | A live query with `fields` re-ran on a change to *any* field of the entities it returned | [#2951](https://github.com/instantdb/instant/issues/2951), PR [#2953](https://github.com/instantdb/instant/pull/2953) |
| **Watch entities that only partly match a `data.ref` rule path** | A live query guarded by `data.ref(...)` didn't refresh when the first matching link was created; only a reload showed it | [#2952](https://github.com/instantdb/instant/issues/2952), PR [#2954](https://github.com/instantdb/instant/pull/2954) |
| Test stub fix | Lets upstream's permission-helper test stub accept the new entity map | n/a |

Already merged upstream and dropped from the stack: *stop a self-hosted server buffering
every transaction in memory* ([#2935](https://github.com/instantdb/instant/pull/2935)).

Known and **not** fixed: a plain `where` through a link (for example
`bookshelves where users.handle in [...]`) can leave a live query stale. That is in the core
query engine and affects upstream equally.

## Using it

The server, the dashboard and every client package are released together, from one
commit, at one version (`<upstream version>-lm.N`). See [Releases](https://github.com/liminisapp/instantdb/releases).

**Server.** Follow upstream's [self-hosting guide](https://www.instantdb.com/docs/self-hosting)
and use our images in place of upstream's:

```yaml
server:
  image: ghcr.io/liminisapp/instant-server:1.0.67-lm.1
dashboard:
  image: ghcr.io/liminisapp/instant-dashboard:1.0.67-lm.1
```

**Clients.** Every `@instantdb/*` package is published as `@liminis/instant-*`. Install
them under their upstream names, so your imports don't change, at the same version as
the server, pinned exactly:

```sh
npm install --save-exact \
  @instantdb/react@npm:@liminis/instant-react@1.0.67-lm.1 \
  @instantdb/admin@npm:@liminis/instant-admin@1.0.67-lm.1
```

Their dependencies on each other already point at our builds, so there is only one copy
of each. The CLI is `@liminis/instant-cli`, and `npm create @liminis/instant-app`
scaffolds an app that uses our packages.

## Roadmap

- [x] Versioned server and dashboard images on GHCR, and every client package on npm, released together
- [ ] CI on every PR (Clojure and JS suites)
- [x] Private vulnerability reporting (a `SECURITY.md` is still to write)
- [ ] Docs for migrating from Instant Cloud to a self-hosted server
- [ ] Track upstream until it stops, then carry security fixes ourselves

## Security

Please don't open a public issue for a vulnerability. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/liminisapp/instantdb/security/advisories/new).

If the issue also affects upstream Instant, we'll coordinate with the upstream maintainers
while they are still accepting reports.

## Contributing

Issues and PRs are welcome, especially fixes for self-hosting problems. A good PR:

- is one focused change with a regression test that fails without it;
- explains the *why* in the commit message, so it can be offered upstream as-is;
- includes no hostnames, app ids or tokens from your own deployment.

## License

Apache-2.0, the same as upstream. See [LICENSE.md](LICENSE.md). Changes made in this fork
are marked in the commit history.
