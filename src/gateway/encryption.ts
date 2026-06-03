/**
 * API-config secret resolution + ECDH config encryption for selected nodes.
 *
 * ⚠️ TODO(verify-against-program/gateway): the envelope byte layout, the ECDH
 * curve (node `signingKey` is assumed secp256k1-compressed-hex), the KDF, and the
 * AEAD cipher (assumed XChaCha20-Poly1305) below are a best-effort reconstruction
 * from the spec. They MUST be reconciled with the gateway/node implementation
 * before publish — nodes will fail to decrypt otherwise.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import { bytesToHex, hexToBytes, utf8 } from "../core/encoding.js";
import type { APIConfig, EncKeyBundle, Node } from "../core/types.js";

const NONCE_BYTES = 24; // XChaCha20-Poly1305 nonce
const SYM_KEY_BYTES = 32;

const SECRET_PLACEHOLDER = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Replace `{{secret.NAME}}` placeholders in the string fields of an API config.
 * Throws if a referenced secret is missing.
 */
export function resolveAPIConfig(
  apiConfig: APIConfig,
  secrets: Record<string, string>,
): APIConfig {
  const sub = (s: string): string =>
    s.replace(SECRET_PLACEHOLDER, (_m, name: string) => {
      if (!(name in secrets)) throw new Error(`Missing secret: ${name}`);
      return secrets[name]!;
    });

  const headers = apiConfig.headers
    ? Object.fromEntries(Object.entries(apiConfig.headers).map(([k, v]) => [k, sub(v)]))
    : undefined;

  return {
    ...apiConfig,
    url: sub(apiConfig.url),
    ...(headers ? { headers } : {}),
    responseParser: sub(apiConfig.responseParser),
    ...(apiConfig.valueTransform ? { valueTransform: sub(apiConfig.valueTransform) } : {}),
  };
}

/**
 * Encrypt a resolved API config with a fresh symmetric key, then ECDH-wrap that
 * key for each selected node. The gateway only ever sees placeholders.
 */
export function encryptForNodes(
  apiConfig: APIConfig,
  secrets: Record<string, string>,
  selectedNodes: Node[],
): EncKeyBundle {
  const resolved = resolveAPIConfig(apiConfig, secrets);
  const plaintext = utf8(JSON.stringify(resolved));

  const symKey = randomBytes(SYM_KEY_BYTES);
  const nonceSym = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(symKey, nonceSym).encrypt(plaintext);

  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true); // compressed

  const envelopes: Record<string, string> = {};
  for (const node of selectedNodes) {
    const nodePub = hexToBytes(node.signingKey);
    const shared = secp256k1.getSharedSecret(ephemeralPriv, nodePub, true);
    const wrapKey = sha256(shared);
    const nonceEnv = randomBytes(NONCE_BYTES);
    const wrappedSymKey = xchacha20poly1305(wrapKey, nonceEnv).encrypt(symKey);
    envelopes[String(node.index)] = bytesToHex(concat(nonceEnv, wrappedSymKey));
  }

  return {
    ephemeralPub: bytesToHex(ephemeralPub),
    nonceSym: bytesToHex(nonceSym),
    ciphertext: bytesToHex(ciphertext),
    envelopes,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
