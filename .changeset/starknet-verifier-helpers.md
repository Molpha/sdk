---
"@molpha-oracle/sdk": patch
---

add Starknet verifier address helpers and calldata builders

Expose the deployed Starknet Sepolia verifier address and helpers to convert a
gateway `DataUpdateResult` into Starknet verifier `DataUpdate` and
`SchnorrSignature` calldata structs.
