# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). It holds the
intent-to-release files that drive versioning and publishing for `@molpha-oracle/sdk`.

## Adding a changeset

Whenever you make a change that should be released, run:

```bash
pnpm changeset
```

Pick the bump type based on the **nature of the change**, not the branch:

- **patch** — bug fix, no API change
- **minor** — new backward-compatible feature
- **major** — breaking change

> Note: while the package is in `0.x`, changesets treats breaking changes as a minor bump
> (`0.1.0 → 0.2.0`) and features/fixes as patch. This is intentional pre-`1.0.0`.

Commit the generated `.changeset/*.md` file along with your code. Releases are produced
automatically once the change lands on `main` (see `.github/workflows/release.yml`).
