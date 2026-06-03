/**
 * Public protocol types (spec §8). Kept dependency-free so they can be imported
 * from any entry point.
 */

/** A registered oracle node as returned by the gateway. */
export interface Node {
  index: number;
  peerId: string;
  address: string;
  /** Node secp256k1 public key (hex). Used for ECDH config encryption. */
  signingKey: string;
}

/** Per-job quorum configuration as returned by the gateway. */
export interface JobConfig {
  signaturesRequired: number;
  redundancyBuffer: number;
  decimals: number;
}

/** The off-chain API definition a job resolves. */
export interface APIConfig {
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  /** Expression that extracts the value from the HTTP response. */
  responseParser: string;
  /** Optional expression applied to the parsed value before packing. */
  valueTransform?: string;
}

/** ECDH-wrapped API config payload sent to selected nodes. */
export interface EncKeyBundle {
  ephemeralPub: string;
  nonceSym: string;
  ciphertext: string;
  /** nodeIndex -> hex(nonceEnv || wrappedSymKey) */
  envelopes: Record<string, string>;
}

/** Signs a message and returns a 64-byte ed25519 signature. */
export type Signer = (message: Uint8Array) => Promise<Uint8Array>;

/**
 * Aggregate Schnorr signature in the commitment-address form the shipped program
 * verifies (`MOLPHA_MESSAGE_V1`). The legacy `(rx, ryParity)` fields are gone.
 */
export interface SchnorrSignature {
  /** 32-byte scalar, hex. */
  s: string;
  /** 20-byte EVM-style commitment address, hex. */
  commitmentAddr: string;
  /** 32-byte big-endian signers bitmap, hex. */
  signersBitmap: string;
}

/** A completed gateway round, ready to submit on-chain. */
export interface DataUpdateResult {
  jobId: string;
  /** Human-readable value. */
  value: string;
  /** 32-byte packed value, hex. */
  valuePacked: string;
  /** canonicalTimestamp (seconds). */
  timestamp: number;
  registryVersion: number;
  signaturesRequired: number;
  /** 32-byte big-endian bitmap, hex. */
  signersBitmap: string;
  /** 32-byte scalar, hex. */
  s: string;
  /** 20-byte commitment address, hex. */
  commitmentAddr: string;
  /** Whether the value was freshly fetched this round. */
  fresh: boolean;
}
