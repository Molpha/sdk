/**
 * API-config secret resolution + ECDH config encryption for selected nodes.
 */
import { gcm } from "@noble/ciphers/aes";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "@noble/hashes/utils";
import { canonicalizeAPIConfig } from "../core/apiconfig.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "../core/encoding.js";
import { normalizeSecp256k1PublicKeyHex } from "../core/nodeKeys.js";
import type { APIConfig, EncKeyBundle, Node } from "../core/types.js";

const NONCE_BYTES = 12; // AES-GCM nonce
const SYM_KEY_BYTES = 32;

const SECRET_PLACEHOLDER = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g;

interface EncryptionRecipient {
  index: number;
  signingKey: string;
}

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
  const recipients = validateEncryptionRecipients(selectedNodes);

  const resolved = resolveAPIConfig(apiConfig, secrets);
  const plaintext = utf8(JSON.stringify(canonicalizeAPIConfig(resolved)));

  const symKey = randomBytes(SYM_KEY_BYTES);
  const nonceSym = randomBytes(NONCE_BYTES);
  const ciphertext = gcm(symKey, nonceSym).encrypt(plaintext);

  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true); // compressed

  const envelopes: Record<string, string> = {};
  for (const node of recipients) {
    const envelopeIndex = String(node.index);
    const nodePub = hexToBytes(node.signingKey);
    const shared = secp256k1.getSharedSecret(ephemeralPriv, nodePub);
    const wrapKey = keccak_256(shared);
    const nonceEnv = randomBytes(NONCE_BYTES);
    const wrappedSymKey = gcm(wrapKey, nonceEnv).encrypt(symKey);
    envelopes[envelopeIndex] = bytesToHex(concatBytes(nonceEnv, wrappedSymKey));
  }

  return {
    ephemeralPub: bytesToHex(ephemeralPub),
    nonceSym: bytesToHex(nonceSym),
    ciphertext: bytesToHex(ciphertext),
    envelopes,
  };
}

function validateEncryptionRecipients(selectedNodes: Node[]): EncryptionRecipient[] {
  if (selectedNodes.length === 0) throw new Error("No nodes to encrypt for");

  const envelopeIndexes = new Set<string>();
  const envelopeKeys = new Set<string>();
  return selectedNodes.map((node) => {
    if (!Number.isInteger(node.index) || node.index < 0) {
      throw new Error(`Selected node index must be a non-negative integer: ${node.index}`);
    }
    const envelopeIndex = String(node.index);
    if (envelopeIndexes.has(envelopeIndex)) {
      throw new Error(`Duplicate selected node index: ${node.index}`);
    }
    envelopeIndexes.add(envelopeIndex);

    const signingKey = normalizeSecp256k1PublicKeyHex(
      node.signingKey,
      `Selected node ${node.index} signingKey`,
    );
    if (envelopeKeys.has(signingKey)) {
      throw new Error(`Duplicate selected node signingKey: ${node.index}`);
    }
    envelopeKeys.add(signingKey);
    return { index: node.index, signingKey };
  });
}
