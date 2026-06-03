/**
 * Job-id derivation. Must stay byte-identical with the Solana program and the EVM
 * verifier — this encodes what the *program* verifies (the 3-field `jobId`), not
 * the richer form described in the protocol spec doc.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, ensureLength, utf8 } from "./encoding.js";

const JOB_ID_PREFIX = utf8("MOLPHA_JOB_V1");

/**
 * `jobId = keccak256(JOB_ID_PREFIX || owner || apiConfigHash)`.
 * @param owner 32-byte owner pubkey.
 * @param apiConfigHash 32-byte API config hash.
 */
export function deriveJobId(owner: Uint8Array, apiConfigHash: Uint8Array): Uint8Array {
  ensureLength(owner, 32, "owner");
  ensureLength(apiConfigHash, 32, "apiConfigHash");
  return keccak_256(concatBytes(JOB_ID_PREFIX, owner, apiConfigHash));
}
