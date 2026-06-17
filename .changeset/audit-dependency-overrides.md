---
"@molpha-oracle/sdk": patch
---

fix audit vulnerabilities in transitive dependencies via pnpm overrides

Force patched versions of vulnerable transitive dependencies:

- `ws` → `>=8.21.0` (DoS via tiny fragments, GHSA-96hv-2xvq-fx4p)
- `js-yaml` → `>=4.2.0` (quadratic-complexity DoS, GHSA-h67p-54hq-rp68)
- `esbuild` → `>=0.28.1` (arbitrary file read on Windows dev server, GHSA-g7r4-m6w7-qqqr)

The `bigint-buffer` advisory (GHSA-3gc7-fjrx-p6mg, via `@solana/spl-token`) has
no patched release available and is ignored through `pnpm.auditConfig.ignoreGhsas`.
