---
"@molpha-oracle/sdk": minor
---

add EVM verifier address constants and tuple helpers

Export deployed Molpha verifier addresses for Ethereum Sepolia, Arbitrum Sepolia,
Avalanche Fuji, and BSC testnet, plus framework-agnostic helpers to convert
`DataUpdateResult` into `verify(DataUpdate, SchnorrSignature)` contract arguments
for use with ethers or viem.
