---
"@molpha-oracle/sdk": minor
---

add a cached-context "short" flow to `MolphaGateway.execute`

Introduce `ExecuteContext` (`registryVersion`, `nodes`, `jobConfig`) and a
`gateway.prepareContext(jobId)` helper that fetches these slow-changing round
inputs once. Pass them back via `execute({ ..., context })` (also accepted by
`executeAndSubmit`) to skip the prelude and run rounds as a single gateway POST.
`context` is partial, so any omitted field is still fetched. The default full
flow now also fetches the registry version, node set, and job config in
parallel.
