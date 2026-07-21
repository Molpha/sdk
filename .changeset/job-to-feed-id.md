---
"@molpha-oracle/sdk": minor
---

rename job IDs to feed IDs and unify the EVM verifier address

Feed terminology replaces job IDs across the public API, and feed derivation now
includes the quorum threshold:

- `deriveJobId` / `deriveJobIdString` → `deriveFeedId` / `deriveFeedIdString`
  (now requires `signaturesRequired`)
- `jobId` options and params → `feedId` (`requestSignedData`, `requestAndSubmit`,
  Solana client helpers, gateway auth message fields)
- Solana account/PDA helpers updated for the feed-id layout

EVM verifier constants collapse to a single CREATE2 address shared by every
supported chain:

- `MOLPHA_VERIFIER_*` per-network constants, `MOLPHA_VERIFIER_ADDRESSES`, and
  `getMolphaVerifierAddress` → `MOLPHA_VERIFIER_ADDRESS`
