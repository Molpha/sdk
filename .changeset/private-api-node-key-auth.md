---
"@molpha-oracle/sdk": patch
---

Authenticate private API node encryption keys before encrypting secrets.

`MolphaGateway.requestSignedData({ encrypt })` now fails closed unless selected
gateway node keys are verified or callers explicitly opt into unsafe development
behavior with `allowUnverifiedNodeKeysForPrivateApi: true`. `MolphaSDK` wires the
default verifier to Solana registry index accounts, comparing on-chain
secp256k1 key coordinates with selected gateway node keys before encryption.
