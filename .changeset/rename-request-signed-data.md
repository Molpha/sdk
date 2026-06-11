---
"@molpha-oracle/sdk": minor
---

rename the gateway round APIs to reflect that they request signed data

The gateway never executes anything on-chain — it returns a threshold-signed
data update. The methods and types are renamed accordingly:

- `MolphaGateway.execute(...)` → `MolphaGateway.requestSignedData(...)`
- `MolphaSDK.executeAndSubmit(...)` → `MolphaSDK.requestAndSubmit(...)`
- `ExecuteOptions` → `RequestSignedDataOptions`
- `ExecuteContext` → `RoundContext`

The gateway HTTP route (`POST /v1/jobs/{id}/execute`) is unchanged.
