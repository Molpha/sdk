# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). It holds the
intent-to-release files that drive versioning and publishing for `@molpha/sdk`.

## Adding a changeset

Whenever you make a change that should be released, run:

```bash
pnpm changeset
```

Pick the bump type based on the **nature of the change**, not the branch:

- **patch** — bug fix, no API change
- **minor** — new backward-compatible feature
- **major** — breaking change

> Note: changesets applies the bump **literally** — a `major` changeset on `0.x` goes straight to
> `1.0.0` (it does not clamp to `0.x`). While the package is pre-`1.0.0`, choose `minor` for breaking
> changes and `patch` for features/fixes, and only pick `major` when you intend to release `1.0.0`.

Commit the generated `.changeset/*.md` file along with your code. Releases are produced
automatically once the change lands on `main` (see `.github/workflows/release.yml`).
