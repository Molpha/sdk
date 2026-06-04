/**
 * Gateway request authentication.
 *
 * `authMessage(jobId, timestamp) = keccak256(jobId_bytes || be64(timestamp))`,
 * signed ed25519 by the job owner / delegate.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, ensureLength, u64be } from "../core/encoding.js";

export type { Signer } from "../core/types.js";

export function authMessage(jobId: Uint8Array, timestamp: number | bigint): Uint8Array {
  ensureLength(jobId, 32, "jobId");
  return keccak_256(concatBytes(jobId, u64be(timestamp)));
}
