/**
 * API config canonicalization + hashing. Must stay byte-identical with gateway/node
 * verification: `apiConfigHash = keccak256(JCS(apiConfig))` (RFC 8785).
 */
import { keccak_256 } from "@noble/hashes/sha3";
import canonicalize from "canonicalize";
import { utf8 } from "./encoding.js";
import type { APIConfig } from "./types.js";

/** Gateway wire shape — defaults applied before JCS hash / encryption. */
export function canonicalizeAPIConfig(apiConfig: APIConfig): APIConfig {
  return {
    url: apiConfig.url,
    method: apiConfig.method ?? "GET",
    headers: apiConfig.headers ?? {},
    responseParser: apiConfig.responseParser,
    valueTransform: apiConfig.valueTransform ?? "multiply:1e6",
  };
}

/**
 * `apiConfigHash = keccak256(JCS(apiConfig))`.
 * Pass the same config (including `{{secret.*}}` placeholders) you will send to
 * `MolphaGateway.execute` when calling `createJob`.
 */
export function deriveApiConfigHash(apiConfig: APIConfig): Uint8Array {
  const canonical = canonicalizeAPIConfig(apiConfig);
  const jcs = canonicalize(canonical);
  if (jcs === undefined) {
    throw new TypeError("apiConfig is not JSON-serializable");
  }
  return keccak_256(utf8(jcs));
}
