/**
 * `MolphaGateway` — isomorphic HTTP client with multi-endpoint failover.
 */
import {
  bytesToHex,
  hexToBytes,
} from "../core/encoding.js";
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
  JobConfig,
  Node,
  Signer,
} from "../core/types.js";
import { authMessage } from "./auth.js";
import { encryptForNodes } from "./encryption.js";

export interface RequestSignedDataOptions {
  jobId: string;
  apiConfig: APIConfig;
  /**
   * Signs `authMessage(jobId, timestamp)`. Overrides the gateway's
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
   * Caching is opt-in because these inputs can drift: a stale `registryVersion`
   * or `nodes` set produces a result the chain will reject. Refresh the context
   * when the on-chain registry version changes.
   */
  context?: Partial<RoundContext>;
}

/**
 * The slow-changing inputs a `requestSignedData` round binds to. Fetch once with
 * {@link MolphaGateway.prepareContext} and reuse across many rounds to skip the
 * registry/nodes/jobConfig prelude.
 */
export interface RoundContext {
  /** On-chain registry version the round is bound to. */
  registryVersion: number;
  /** Full node set used to derive the selection bitmap. */
  nodes: Node[];
  /** Per-job quorum configuration. */
  jobConfig: JobConfig;
}

interface GatewaySignedDataResponse {
  status: "completed" | "pending" | string;
  data?: GatewaySignedData;
}

interface GatewaySignedData {
  jobId?: string;
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
const JOB_CONFIG_RETRY_ATTEMPTS = 10;
const JOB_CONFIG_RETRY_INITIAL_DELAY_MS = 250;
const JOB_CONFIG_RETRY_MAX_DELAY_MS = 2000;

/** Default gateway base URL when `endpoints` is omitted. */
export const DEFAULT_GATEWAY_ENDPOINT = "https://gateway.molpha.io";

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
  private readonly getRegistryVersion: () => Promise<number>;
  private readonly defaultSigner?: Signer;

  constructor(
    endpoints?: string | string[],
    getRegistryVersion: () => Promise<number> = async () => {
      throw new Error(
        "MolphaGateway requires getRegistryVersion to request signed data — pass the current on-chain version (e.g. () => solana.getRegistryVersion())",
      );
    },
    defaultSigner?: Signer,
  ) {
    const list =
      endpoints === undefined
        ? [DEFAULT_GATEWAY_ENDPOINT]
        : Array.isArray(endpoints)
          ? endpoints
          : [endpoints];
    if (list.length === 0) throw new Error("At least one endpoint is required");
    this.endpoints = list.map((e) => e.replace(/\/$/, ""));
    this.getRegistryVersion = getRegistryVersion;
    this.defaultSigner = defaultSigner;
  }

  /** Tries endpoints in order; returns the first node list it can fetch. */
  async getNodes(): Promise<Node[]> {
    const data = await this.firstReachableData<{ nodes: Node[] } | Node[]>("/v1/nodes");
    return Array.isArray(data) ? data : data.nodes;
  }

  async getJobConfig(jobId: string): Promise<JobConfig> {
    return this.firstReachableData<JobConfig>(`/v1/jobs/${jobId}/config`);
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
   * Fetch the slow-changing round inputs (registry version, node set, job
   * config) once so they can be reused across many {@link requestSignedData}
   * calls. Pass the result back via `requestSignedData({ ..., context })` to
   * skip the prelude and run a single-round "short" flow.
   *
   * All three fetches run in parallel.
   */
  async prepareContext(jobId: string): Promise<RoundContext> {
    const [registryVersion, nodes, jobConfig] = await Promise.all([
      this.getRegistryVersion(),
      this.getNodes(),
      this.getJobConfigWithRetry(jobId),
    ]);
    return { registryVersion, nodes, jobConfig };
  }

  /**
   * Request a threshold-signed data update from the gateway, with retry +
   * failover. Per attempt a fresh timestamp yields a fresh selection bitmap; the
   * body is POSTed to each endpoint in order until one `completed`s.
   *
   * By default this fetches the registry version, node set, and job config up
   * front (in parallel). Supply `opts.context` (e.g. from
   * {@link prepareContext}) to reuse cached inputs and skip those fetches — a
   * fully-populated context collapses the call to a single POST round.
   */
  async requestSignedData(opts: RequestSignedDataOptions): Promise<DataUpdateResult> {
    const {
      jobId,
      apiConfig,
      signer,
      encrypt,
      maxAge = 60,
      maxRetries = 15,
      timeoutMs = 5000,
    } = opts;

    const jobIdBytes = hexToBytes(jobId);
    const { registryVersion, nodes, jobConfig } = await this.resolveContext(
      jobId,
      opts.context,
    );

    const requestApiConfig = canonicalizeAPIConfig(apiConfig);

    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);

      const seed = deriveSelectionSeed(jobIdBytes, registryVersion, timestamp);
      const groupSize = effectiveSelectionSize(
        jobConfig.signaturesRequired,
        jobConfig.redundancyBuffer,
        nodes.length,
      );
      const bitmap = deriveGroupBitmap(seed, nodes.length, groupSize);
      const indices = selectedIndices(bitmap, nodes.length);
      const selected = nodes.filter((n) => indices.includes(n.index));

      const authSigner = signer ?? this.defaultSigner;
      const authSig = authSigner
        ? await authSigner(authMessage(jobIdBytes, timestamp))
        : ZERO_AUTH_SIG;

      const body: Record<string, unknown> = {
        registryVersion,
        timestamp,
        maxAge,
        authSig: bytesToHex(authSig),
        apiConfig: requestApiConfig,
      };
      if (encrypt) {
        body.encKeyBundle = encryptForNodes(requestApiConfig, encrypt.secrets, selected);
      }

      for (const endpoint of this.endpoints) {
        try {
          const res = await this.post(
            `${endpoint}/v1/jobs/${jobId}/execute`,
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
              jobId,
              registryVersion,
              timestamp,
              signaturesRequired: jobConfig.signaturesRequired,
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
   * Whatever fetching remains runs in parallel.
   */
  private async resolveContext(
    jobId: string,
    cached?: Partial<RoundContext>,
  ): Promise<RoundContext> {
    const [registryVersion, nodes, jobConfig] = await Promise.all([
      cached?.registryVersion !== undefined
        ? Promise.resolve(cached.registryVersion)
        : this.getRegistryVersion(),
      cached?.nodes !== undefined
        ? Promise.resolve(cached.nodes)
        : this.getNodes(),
      cached?.jobConfig !== undefined
        ? Promise.resolve(cached.jobConfig)
        : this.getJobConfigWithRetry(jobId),
    ]);
    return { registryVersion, nodes, jobConfig };
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

  private async getJobConfigWithRetry(jobId: string): Promise<JobConfig> {
    let lastError: unknown;
    let delayMs = JOB_CONFIG_RETRY_INITIAL_DELAY_MS;

    for (let attempt = 0; attempt < JOB_CONFIG_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.getJobConfig(jobId);
      } catch (err) {
        if (!(err instanceof GatewayError && err.status === 404)) {
          throw err;
        }
        lastError = err;
      }

      if (attempt < JOB_CONFIG_RETRY_ATTEMPTS - 1) {
        await sleep(delayMs);
        delayMs = Math.min(
          Math.floor(delayMs * 1.5),
          JOB_CONFIG_RETRY_MAX_DELAY_MS,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new GatewayError(`GET /v1/jobs/${jobId}/config failed`, 404);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    jobId: string;
    registryVersion: number;
    timestamp: number;
    signaturesRequired: number;
    bitmap: Uint8Array;
  },
): DataUpdateResult {
  return {
    jobId: data.jobId ?? ctx.jobId,
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
