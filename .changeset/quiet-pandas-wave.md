---
"@molpha-oracle/sdk": patch
---

align `deriveApiConfigHash` with node hashing (`keccak256(JSON.stringify(canonicalApiConfig))`)

API config hashing now matches node-side verification by hashing the canonicalized
config JSON string directly (with SDK defaults applied), instead of JCS.
