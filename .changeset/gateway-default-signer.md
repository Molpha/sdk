---
"@molpha-oracle/sdk": patch
---

wire wallet auth into `MolphaSDK.gateway.execute`

`MolphaSDK` now passes the wallet's gateway signer to `MolphaGateway` as its
default, so `sdk.gateway.execute({ jobId, apiConfig })` authenticates without
an explicit `signer`. Per-call `signer` still overrides the default.
Standalone `MolphaGateway` accepts an optional third `defaultSigner` constructor
argument; omitting it keeps the all-zero dev `authSig` behavior.
