/**
 * Gateway request authentication.
 *
 * `authMessage(feedId, timestamp) = sha256("MOLPHA_REQAUTH_V1" || feed_id || uint64_le(timestamp))`,
 * signed ed25519 by the consumer authority / delegate.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, ensureLength, utf8, u64le } from "../core/encoding.js";

export type { Signer } from "../core/types.js";

const REQUEST_AUTH_DOMAIN = utf8("MOLPHA_REQAUTH_V1");

export function authMessage(feedId: Uint8Array, timestamp: number | bigint): Uint8Array {
  ensureLength(feedId, 32, "feedId");
  return sha256(concatBytes(REQUEST_AUTH_DOMAIN, feedId, u64le(timestamp)));
}
