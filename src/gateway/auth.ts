/**
 * Gateway request authentication.
 *
 * `authMessage(feedId, timestamp) = keccak256(feedId_bytes || be64(timestamp))`,
 * signed ed25519 by the feed owner / delegate.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, ensureLength, u64be } from "../core/encoding.js";

export type { Signer } from "../core/types.js";

export function authMessage(feedId: Uint8Array, timestamp: number | bigint): Uint8Array {
  ensureLength(feedId, 32, "feedId");
  return keccak_256(concatBytes(feedId, u64be(timestamp)));
}
