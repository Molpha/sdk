/**
 * Feed-id derivation. Must stay byte-identical with the Solana program and the EVM
 * verifier — this encodes what the *program* verifies (the 4-field `feedId`), not
 * the richer form described in the protocol spec doc.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, ensureLength, utf8 } from "./encoding.js";

const FEED_ID_PREFIX = utf8("MOLPHA_JOB_V1");

/**
 * `feedId = keccak256(FEED_ID_PREFIX || owner || apiConfigHash || [signaturesRequired])`.
 * @param owner 32-byte owner pubkey.
 * @param apiConfigHash 32-byte API config hash.
 * @param signaturesRequired Per-feed quorum threshold (u8 on-chain).
 */
export function deriveFeedId(
  owner: Uint8Array,
  apiConfigHash: Uint8Array,
  signaturesRequired: number,
): Uint8Array {
  ensureLength(owner, 32, "owner");
  ensureLength(apiConfigHash, 32, "apiConfigHash");
  if (!Number.isInteger(signaturesRequired) || signaturesRequired < 0 || signaturesRequired > 255) {
    throw new RangeError(`signaturesRequired out of range: ${signaturesRequired}`);
  }
  return keccak_256(
    concatBytes(FEED_ID_PREFIX, owner, apiConfigHash, Uint8Array.of(signaturesRequired)),
  );
}

/** Hex-encoded `deriveFeedId` (64 lowercase hex chars). */
export function deriveFeedIdString(
  owner: Uint8Array,
  apiConfigHash: Uint8Array,
  signaturesRequired: number,
): string {
  return bytesToHex(deriveFeedId(owner, apiConfigHash, signaturesRequired));
}
