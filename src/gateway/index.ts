/**
 * `MolphaGateway` — isomorphic HTTP client with multi-endpoint failover.
 */
import {
  bytesToHex,
  bytesToHex0x,
  hexToBytes,
} from "../core/encoding.js";
import { normalizeSecp256k1PublicKeyHex } from "../core/nodeKeys.js";
import { canonicalizeAPIConfig } from "../core/apiconfig.js";
import {
  deriveGroupBitmap,
  deriveSelectionSeed,
  effectiveSelectionSize,
  selectedIndices,
} from "../core/selection.js";
import type {
  APIConfig,
  DataUpdateResult,
  Node,
  NodeKeyVerifier,
  RegistrySelectionConfig,
  Signer,
} from "../core/types.js";
import { authMessage } from "./auth.js";
import { encryptForNodes } from "./encryption.js";

export type { RegistrySelectionConfig } from "../core/types.js";

export interface RequestSignedDataOptions {
  feedId: string;
  signaturesRequired: number;
  apiConfig: APIConfig;
  /**
   * Solana pubkey (base58) of the subscription owner.
   * Overrides the gateway's `defaultSubscriptionOwner` when set.
   */
  subscriptionOwner?: string;
  /**
   * Solana pubkey (base58) of the consumer authority that signs gateway auth.
   * Overrides the gateway's `defaultConsumerAuthority` when set.
   */
  consumerAuthority?: string;
  /**
   * Signs `authMessage(feedId, timestamp)`. Overrides the gateway's
   * `defaultSigner` when set. When both are omitted, sends all-zero authSig
   * (dev only).
   */
  signer?: Signer;
  encrypt?: { secrets: Record<string, string> };
  /** Max accepted value age in seconds. Default 60. */
  maxAge?: number;
  /** Each retry re-rolls the timestamp. Default 15. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Pre-fetched round inputs. Any field present here skips its network/on-chain
   * fetch, so a fully-populated context turns `requestSignedData` into a single
   * POST round (the "short" flow). Build a reusable one with
   * {@link MolphaGateway.prepareContext}.
   *
   * Caching is opt-in because these inputs can drift: a stale `registryVersion`,
   * `redundancyBuffer`, or `nodes` set produces a result the chain will reject.
   * Refresh the context when the on-chain registry version changes.
   */
  context?: Partial<RoundContext>;
  /**
   * Authenticates selected gateway node encryption keys before private API
   * secrets are encrypted. Overrides the gateway-level verifier when set.
   */
  verifyNodeKeys?: NodeKeyVerifier;
  /**
   * Unsafe development escape hatch for standalone gateway usage. When true,
   * encrypted private API requests may use gateway-provided node keys without
   * authentication. Defaults to false.
   */
  allowUnverifiedNodeKeysForPrivateApi?: boolean;
}

export interface MolphaGatewayOptions {
  /** Solana pubkey (base58) of the subscription owner used when a request omits it. */
  defaultSubscriptionOwner?: string;
  /** Solana pubkey (base58) of the consumer authority used when a request omits it. */
  defaultConsumerAuthority?: string;
  /**
   * Authenticates selected gateway node encryption keys before private API
   * secrets are encrypted.
   */
  verifyNodeKeys?: NodeKeyVerifier;
  /**
   * Unsafe development escape hatch. When true, encrypted private API requests
   * may use gateway-provided node keys without authentication. Defaults to false.
   */
  allowUnverifiedNodeKeysForPrivateApi?: boolean;
}

/**
 * The slow-changing inputs a `requestSignedData` round binds to. Fetch once with
 * {@link MolphaGateway.prepareContext} and reuse across many rounds
 */
export interface RoundContext extends RegistrySelectionConfig {
  /** Full node set used to derive the selection bitmap. */
  nodes: Node[];
}

interface GatewaySignedDataResponse {
  status: "completed" | "pending" | string;
  data?: GatewaySignedData;
}

interface GatewaySignedData {
  feedId?: string;
  value?: string;
  valuePacked?: string;
  timestamp?: number;
  registryVersion?: number;
  signaturesRequired?: number;
  signersBitmap?: string;
  s?: string;
  commitmentAddr?: string;
  fresh?: boolean;
}

interface GatewayEnvelope<T> {
  status: string;
  data: T;
}

const ZERO_AUTH_SIG = new Uint8Array(64);

/** Default gateway base URL when `endpoints` is omitted. */
export const DEFAULT_GATEWAY_ENDPOINT = "https://dev-gateway.molpha.io/";

/** Thrown for terminal gateway errors (400/401) — never retried. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export class MolphaGateway {
  private readonly endpoints: string[];
  private readonly getRegistrySelectionConfig: () => Promise<RegistrySelectionConfig>;
  private readonly defaultSigner?: Signer;
  private readonly defaultSubscriptionOwner?: string;
  private readonly defaultConsumerAuthority?: string;
  private readonly verifyNodeKeys?: NodeKeyVerifier;
  private readonly allowUnverifiedNodeKeysForPrivateApi: boolean;

  constructor(
    endpoints?: string | string[],
    getRegistrySelectionConfig: () => Promise<RegistrySelectionConfig> = async () => {
      throw new Error(
        "MolphaGateway requires getRegistrySelectionConfig to request signed data — pass the current on-chain registry version and redundancy buffer (e.g. () => solana.getRegistrySelectionConfig())",
      );
    },
    defaultSigner?: Signer,
    /**
     * Either a default subscription owner (base58) or gateway options. A string
     * keeps the previous positional form used by standalone callers/tests.
     */
    defaultSubscriptionOwnerOrOptions?: string | MolphaGatewayOptions,
    defaultConsumerAuthority?: string,
  ) {
    const list =
      endpoints === undefined
        ? [DEFAULT_GATEWAY_ENDPOINT]
        : Array.isArray(endpoints)
          ? endpoints
          : [endpoints];
    if (list.length === 0) throw new Error("At least one endpoint is required");
    this.endpoints = list.map((e) => e.replace(/\/$/, ""));
    this.getRegistrySelectionConfig = getRegistrySelectionConfig;
    this.defaultSigner = defaultSigner;

    const options: MolphaGatewayOptions =
      typeof defaultSubscriptionOwnerOrOptions === "string"
        ? {
            defaultSubscriptionOwner: defaultSubscriptionOwnerOrOptions,
            defaultConsumerAuthority,
          }
        : (defaultSubscriptionOwnerOrOptions ?? {});

    this.defaultSubscriptionOwner = options.defaultSubscriptionOwner;
    this.defaultConsumerAuthority =
      options.defaultConsumerAuthority ?? options.defaultSubscriptionOwner;
    this.verifyNodeKeys = options.verifyNodeKeys;
    this.allowUnverifiedNodeKeysForPrivateApi =
      options.allowUnverifiedNodeKeysForPrivateApi ?? false;
  }

  /** Tries endpoints in order; returns the first node list it can fetch. */
  async getNodes(): Promise<Node[]> {
    const data = await this.firstReachableData<{ nodes: Node[] } | Node[]>("/v1/nodes");
    return Array.isArray(data) ? data : data.nodes;
  }

  async isHealthy(): Promise<boolean> {
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint}/health`, { method: "GET" });
        if (res.ok) return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  /**
   * Fetch the slow-changing round inputs (registry version, redundancy buffer,
   * node set) once so they can be reused across many {@link requestSignedData}
   * calls. Pass the result back via `requestSignedData({ ..., context })` to
   * skip the prelude and run a single-round "short" flow.
   *
   * Both fetches run in parallel. Registry version and redundancy buffer come
   * from a single on-chain `RegistryState` read.
   */
  async prepareContext(_feedId: string): Promise<RoundContext> {
    const [registry, nodes] = await Promise.all([
      this.getRegistrySelectionConfig(),
      this.getNodes(),
    ]);
    return { ...registry, nodes };
  }

  /**
   * Request a threshold-signed data update from the gateway, with retry +
   * failover. Per attempt a fresh timestamp yields a fresh selection bitmap; the
   * body is POSTed to each endpoint in order until one `completed`s.
   *
   * By default this fetches the registry selection config and node set up front
   * (in parallel). Supply `opts.context` (e.g. from {@link prepareContext}) to
   * reuse cached inputs and skip those fetches — a fully-populated context
   * collapses the call to a single POST round.
   */
  async requestSignedData(opts: RequestSignedDataOptions): Promise<DataUpdateResult> {
    const {
      feedId,
      apiConfig,
      signer,
      encrypt,
      maxAge = 60,
      maxRetries = 15,
      timeoutMs = 5000,
    } = opts;

    const verifyNodeKeys = opts.verifyNodeKeys ?? this.verifyNodeKeys;
    const allowUnverified =
      opts.allowUnverifiedNodeKeysForPrivateApi ??
      this.allowUnverifiedNodeKeysForPrivateApi;
    if (encrypt && !verifyNodeKeys && !allowUnverified) {
      throw new Error(
        "Private API encryption requires authenticated node keys. Provide verifyNodeKeys or set allowUnverifiedNodeKeysForPrivateApi: true for unsafe development use.",
      );
    }

    const feedIdBytes = hexToBytes(feedId);
    const { registryVersion, redundancyBuffer, nodes } = await this.resolveContext(
      feedId,
      opts.context,
    );

    const requestApiConfig = canonicalizeAPIConfig(apiConfig);
    const subscriptionOwner = opts.subscriptionOwner ?? this.defaultSubscriptionOwner;
    if (!subscriptionOwner) {
      throw new Error(
        "subscriptionOwner is required — pass opts.subscriptionOwner or set MolphaGateway defaultSubscriptionOwner (MolphaSDK sets this from wallet.publicKey)",
      );
    }
    const consumerAuthority =
      opts.consumerAuthority ?? this.defaultConsumerAuthority ?? subscriptionOwner;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);

      const seed = deriveSelectionSeed(feedIdBytes, registryVersion, timestamp);
      const groupSize = effectiveSelectionSize(
        opts.signaturesRequired,
        redundancyBuffer,
        nodes.length,
      );
      const bitmap = deriveGroupBitmap(seed, nodes.length, groupSize);
      const indices = selectedIndices(bitmap, nodes.length);

      let encKeyBundle: ReturnType<typeof encryptForNodes> | undefined;
      if (encrypt) {
        const selected = selectedNodesForPrivateApiEncryption(nodes, indices);

        if (verifyNodeKeys) {
          await verifyNodeKeys({
            feedId,
            registryVersion,
            timestamp,
            selectedIndexes: [...indices],
            selectedNodes: selected.map((node) => ({ ...node })),
          });
        }

        encKeyBundle = encryptForNodes(requestApiConfig, encrypt.secrets, selected);
      }

      const authSigner = signer ?? this.defaultSigner;
      const authSig = authSigner
        ? await authSigner(authMessage(feedIdBytes, timestamp))
        : ZERO_AUTH_SIG;

      const body: Record<string, unknown> = {
        feedId,
        registryVersion,
        timestamp,
        maxAge,
        signaturesRequired: opts.signaturesRequired,
        subscriptionOwner,
        consumerAuthority,
        authSig: bytesToHex0x(authSig),
        apiConfig: requestApiConfig,
      };
      if (encKeyBundle) body.encKeyBundle = encKeyBundle;

      for (const endpoint of this.endpoints) {
        try {
          const res = await this.post(
            `${endpoint}/v1/round/execute`,
            body,
            timeoutMs,
          );
          const errorDetail = !res.ok ? await parseGatewayErrorDetail(res) : undefined;
          if (res.status === 400 || res.status === 401) {
            throw new GatewayError(
              formatGatewayErrorMessage("Gateway rejected request", res.status, errorDetail),
              res.status,
            );
          }
          if (res.status === 503) {
            lastError = new GatewayError(
              formatGatewayErrorMessage("Gateway unavailable", 503, errorDetail),
              503,
            );
            continue; // a different gateway may already hold the AggSig
          }
          if (!res.ok) {
            lastError = new GatewayError(
              formatGatewayErrorMessage("Gateway error", res.status, errorDetail),
              res.status,
            );
            continue;
          }
          const json = (await res.json()) as GatewaySignedDataResponse;
          const payload = json.data ?? (
            json.status === "completed" ? (json as unknown as GatewaySignedData) : undefined
          );
          if (json.status === "completed" && payload) {
            return toResult(payload, {
              feedId,
              registryVersion,
              timestamp,
              signaturesRequired: opts.signaturesRequired,
              bitmap,
            });
          }
          lastError = new Error(`Gateway returned status: ${json.status}`);
        } catch (err) {
          if (err instanceof GatewayError && (err.status === 400 || err.status === 401)) {
            throw err;
          }
          lastError = err; // timeout / network → next endpoint
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Gateway round failed after retries");
  }

  /**
   * Resolve the round inputs, fetching only the fields absent from `cached`.
   * Registry version and redundancy buffer are treated as a unit (one account
   * read). Whatever fetching remains runs in parallel.
   */
  private async resolveContext(
    _feedId: string,
    cached?: Partial<RoundContext>,
  ): Promise<RoundContext> {
    const hasRegistry =
      cached?.registryVersion !== undefined && cached?.redundancyBuffer !== undefined;
    const [registry, nodes] = await Promise.all([
      hasRegistry
        ? Promise.resolve({
            registryVersion: cached.registryVersion!,
            redundancyBuffer: cached.redundancyBuffer!,
          })
        : this.getRegistrySelectionConfig(),
      cached?.nodes !== undefined
        ? Promise.resolve(cached.nodes)
        : this.getNodes(),
    ]);
    return { ...registry, nodes };
  }

  private async firstReachableData<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint}${path}`, { method: "GET" });
        if (res.ok) {
          const json = (await res.json()) as unknown;
          if (json && typeof json === "object" && "data" in json) {
            const wrapped = json as Partial<GatewayEnvelope<T>>;
            if (wrapped.data === undefined) {
              throw new GatewayError(`GET ${path} returned malformed payload`, res.status);
            }
            return wrapped.data;
          }
          return json as T;
        }
        lastError = new GatewayError(`GET ${path} failed (${res.status})`, res.status);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
  }

  private async post(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function selectedNodesForPrivateApiEncryption(
  nodes: Node[],
  selectedIndexes: number[],
): Node[] {
  if (!Array.isArray(nodes)) {
    throw new Error("Private API encryption requires a gateway node array");
  }
  if (selectedIndexes.length === 0) {
    throw new Error("Private API encryption requires at least one selected node");
  }

  const selectedIndexSet = new Set<number>();
  for (const index of selectedIndexes) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Private API encryption selected index must be a non-negative integer: ${index}`,
      );
    }
    if (selectedIndexSet.has(index)) {
      throw new Error(`Private API encryption selected index is duplicated: ${index}`);
    }
    selectedIndexSet.add(index);
  }

  const selectedByIndex = new Map<number, Node>();
  const nodeIndexes = new Set<number>();
  for (const node of nodes) {
    if (!Number.isInteger(node.index) || node.index < 0) {
      throw new Error(`Gateway node index must be a non-negative integer: ${node.index}`);
    }
    if (node.index >= nodes.length) {
      throw new Error(
        `Gateway node index ${node.index} is outside the node list range 0..${nodes.length - 1}`,
      );
    }
    if (nodeIndexes.has(node.index)) {
      throw new Error(`Gateway returned duplicate node index: ${node.index}`);
    }
    nodeIndexes.add(node.index);
    if (!selectedIndexSet.has(node.index)) continue;
    selectedByIndex.set(node.index, node);
  }

  const selectedSigningKeys = new Set<string>();
  return selectedIndexes.map((index) => {
    const node = selectedByIndex.get(index);
    if (!node) {
      throw new Error(`Gateway node list is missing selected node index: ${index}`);
    }
    const signingKey = normalizeSecp256k1PublicKeyHex(
      node.signingKey,
      `Gateway selected node ${index} signingKey`,
    );
    if (selectedSigningKeys.has(signingKey)) {
      throw new Error(`Gateway returned duplicate selected node signingKey: ${index}`);
    }
    selectedSigningKeys.add(signingKey);
    return node;
  });
}

function formatGatewayErrorMessage(
  prefix: string,
  status: number,
  detail?: string,
): string {
  if (!detail) return `${prefix} (${status})`;
  return `${prefix} (${status}): ${detail}`;
}

async function parseGatewayErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).trim();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const message = record.error ?? record.message ?? record.detail;
        if (typeof message === "string" && message.trim()) return message.trim();
      }
    } catch {
      // fall back to raw body below
    }
    return text;
  } catch {
    return undefined;
  }
}

function toResult(
  data: GatewaySignedData,
  ctx: {
    feedId: string;
    registryVersion: number;
    timestamp: number;
    signaturesRequired: number;
    bitmap: Uint8Array;
  },
): DataUpdateResult {
  return {
    feedId: data.feedId ?? ctx.feedId,
    value: data.value ?? "",
    valuePacked: data.valuePacked ?? "",
    timestamp: data.timestamp ?? ctx.timestamp,
    registryVersion: data.registryVersion ?? ctx.registryVersion,
    signaturesRequired: data.signaturesRequired ?? ctx.signaturesRequired,
    signersBitmap: data.signersBitmap ?? bytesToHex(ctx.bitmap),
    s: data.s ?? "",
    commitmentAddr: data.commitmentAddr ?? "",
    fresh: data.fresh ?? true,
  };
}
