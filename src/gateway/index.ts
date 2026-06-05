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

export interface ExecuteOptions {
  jobId: string;
  apiConfig: APIConfig;
  /** Omitted ⇒ all-zero authSig (dev only). */
  signer?: Signer;
  encrypt?: { secrets: Record<string, string> };
  /** Max accepted value age in seconds. Default 60. */
  maxAge?: number;
  /** Each retry re-rolls the timestamp. Default 15. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

interface GatewayExecuteResponse {
  status: "completed" | "pending" | string;
  data?: GatewayExecuteData;
}

interface GatewayExecuteData {
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

/** Default gateway base URL when `endpoints` is omitted. */
export const DEFAULT_GATEWAY_ENDPOINT = "http://188.166.222.245:8080";

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

  constructor(
    endpoints?: string | string[],
    getRegistryVersion: () => Promise<number> = async () => {
      throw new Error(
        "MolphaGateway requires getRegistryVersion to execute — pass the current on-chain version (e.g. () => solana.getRegistryVersion())",
      );
    },
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
   * Run a gateway round with retry + failover. Per attempt a fresh timestamp
   * yields a fresh selection bitmap; the body is POSTed to each endpoint in
   * order until one `completed`s.
   */
  async execute(opts: ExecuteOptions): Promise<DataUpdateResult> {
    const {
      jobId,
      apiConfig,
      signer,
      encrypt,
      maxAge = 60,
      maxRetries = 15,
      timeoutMs = 5000,
    } = opts;

    const registryVersion = await this.getRegistryVersion();
    const jobIdBytes = hexToBytes(jobId);
    const [nodes, jobConfig] = await Promise.all([
      this.getNodes(),
      this.getJobConfig(jobId),
    ]);

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

      const authSig = signer
        ? await signer(authMessage(jobIdBytes, timestamp))
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
          if (res.status === 400 || res.status === 401) {
            throw new GatewayError(
              `Gateway rejected request (${res.status})`,
              res.status,
            );
          }
          if (res.status === 503) {
            lastError = new GatewayError("Gateway unavailable (503)", 503);
            continue; // a different gateway may already hold the AggSig
          }
          if (!res.ok) {
            lastError = new GatewayError(`Gateway error (${res.status})`, res.status);
            continue;
          }
          const json = (await res.json()) as GatewayExecuteResponse;
          const payload = json.data ?? (
            json.status === "completed" ? (json as unknown as GatewayExecuteData) : undefined
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

function toResult(
  data: GatewayExecuteData,
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
