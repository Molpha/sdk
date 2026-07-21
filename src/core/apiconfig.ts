/**
 * API config canonicalization + hashing. Must stay byte-identical with gateway/node
 * verification: `apiConfigHash = keccak256(JSON.stringify(apiConfig))`.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8 } from "./encoding.js";
import type { APIConfig } from "./types.js";

/** Gateway wire shape — defaults applied before hash / encryption. */
export function canonicalizeAPIConfig(apiConfig: APIConfig): APIConfig {
  return {
    url: apiConfig.url,
    method: apiConfig.method ?? "GET",
    headers: apiConfig.headers ?? {},
    responseParser: apiConfig.responseParser,
    valueTransform: apiConfig.valueTransform ?? "",
  };
}

/**
 * `apiConfigHash = keccak256(JSON.stringify(canonical apiConfig))`.
 * Pass the same config (including `{{secret.*}}` placeholders) you will send to
 * `MolphaGateway.requestSignedData` when deriving a feed id.
 */
export function deriveApiConfigHash(apiConfig: APIConfig): Uint8Array {
  return keccak_256(utf8(JSON.stringify(canonicalizeAPIConfig(apiConfig))));
}
