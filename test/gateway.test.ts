import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "../src/core/encoding.js";
import { GatewayError, MolphaGateway } from "../src/gateway/index.js";

const JOB_ID = "11".repeat(32);

const nodes = [
  { index: 0, peerId: "a", address: "n0", signingKey: "02".padEnd(66, "0") },
  { index: 1, peerId: "b", address: "n1", signingKey: "03".padEnd(66, "0") },
  { index: 2, peerId: "c", address: "n2", signingKey: "02".padEnd(66, "1") },
];
const jobConfig = { signaturesRequired: 1, redundancyBuffer: 0, decimals: 8 };
const privateApiConfig = {
  url: "http://api/{{secret.token}}",
  responseParser: "$.price",
};
const privateApiEncrypt = { secrets: { token: "secret-token" } };
const encryptedNodes = [0, 1, 2].map((index) => ({
  index,
  peerId: `p${index}`,
  address: `n${index}`,
  signingKey: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true)),
}));
const encryptedJobConfig = { signaturesRequired: 3, redundancyBuffer: 0, decimals: 8 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes GETs to nodes/config and lets the test control each /execute POST. */
function mockFetch(executeHandler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/execute")) return executeHandler(url);
    if (url.endsWith("/nodes")) return jsonResponse(nodes);
    if (url.endsWith("/config")) return jsonResponse(jobConfig);
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MolphaGateway.requestSignedData failover", () => {
  it("returns the result when a gateway completes", async () => {
    globalThis.fetch = mockFetch(() =>
      jsonResponse({
        status: "completed",
        value: "100",
        valuePacked: "00".repeat(32),
        signersBitmap: "00".repeat(31) + "01",
        s: "aa".repeat(32),
        commitmentAddr: "bb".repeat(20),
        signaturesRequired: 1,
        fresh: true,
      }),
    ) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1);
    const result = await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });
    expect(result.value).toBe("100");
    expect(result.commitmentAddr).toBe("bb".repeat(20));
  });

  it("retries on initial job config 404 for fresh jobs", async () => {
    let configCalls = 0;
    const executeHandler = vi.fn(() => jsonResponse({ status: "completed", value: "100" }));

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/execute")) return executeHandler();
      if (url.endsWith("/nodes")) return jsonResponse(nodes);
      if (url.endsWith("/config")) {
        configCalls += 1;
        if (configCalls < 3) return jsonResponse({ error: "not found" }, 404);
        return jsonResponse(jobConfig);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1);
    const result = await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });

    expect(result.value).toBe("100");
    expect(configCalls).toBe(3);
    expect(executeHandler).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 400 without trying the next endpoint", async () => {
    const handler = vi.fn(() => jsonResponse({ error: "bad" }, 400));
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], async () => 1);
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        maxRetries: 3,
        apiConfig: { url: "http://api", responseParser: "$.price" },
      }),
    ).rejects.toMatchObject({
      name: "GatewayError",
      status: 400,
      message: "Gateway rejected request (400): bad",
    });
    expect(handler).toHaveBeenCalledTimes(1); // did not fall through
  });

  it("falls through 503 to the next endpoint", async () => {
    const handler = vi.fn((url: string) =>
      url.startsWith("http://gw1")
        ? jsonResponse({ error: "busy" }, 503)
        : jsonResponse({ status: "completed", value: "7" }),
    );
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], async () => 1);
    const result = await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });
    expect(result.value).toBe("7");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns 503 details when all endpoints fail", async () => {
    const handler = vi.fn(() =>
      jsonResponse({ error: "group size 4 exceeds total node count 3" }, 503),
    );
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1);
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        maxRetries: 1,
        apiConfig: { url: "http://api", responseParser: "$.price" },
      }),
    ).rejects.toMatchObject({
      name: "GatewayError",
      status: 503,
      message:
        "Gateway unavailable (503): group size 4 exceeds total node count 3",
    });
  });
});

describe("MolphaGateway defaultSigner", () => {
  it("uses defaultSigner when requestSignedData omits signer", async () => {
    const defaultSigner = vi.fn(async () => new Uint8Array(64).fill(0xab));
    let postedBody: Record<string, unknown> | undefined;

    globalThis.fetch = mockFetch(() => {
      return jsonResponse({ status: "completed", value: "1" });
    }) as unknown as typeof fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/execute")) {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ status: "completed", value: "1" });
      }
      if (url.endsWith("/nodes")) return jsonResponse(nodes);
      if (url.endsWith("/config")) return jsonResponse(jobConfig);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1, defaultSigner);
    await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });

    expect(defaultSigner).toHaveBeenCalledTimes(1);
    expect(postedBody?.authSig).toBe("ab".repeat(64));
  });

  it("prefers per-call signer over defaultSigner", async () => {
    const defaultSigner = vi.fn(async () => new Uint8Array(64).fill(0xab));
    const overrideSigner = vi.fn(async () => new Uint8Array(64).fill(0xcd));
    let postedBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/execute")) {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ status: "completed", value: "1" });
      }
      if (url.endsWith("/nodes")) return jsonResponse(nodes);
      if (url.endsWith("/config")) return jsonResponse(jobConfig);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1, defaultSigner);
    await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
      signer: overrideSigner,
    });

    expect(defaultSigner).not.toHaveBeenCalled();
    expect(overrideSigner).toHaveBeenCalledTimes(1);
    expect(postedBody?.authSig).toBe("cd".repeat(64));
  });
});

describe("MolphaGateway.requestSignedData cached context (short flow)", () => {
  it("skips the prelude fetches when a full context is supplied", async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({ status: "completed", value: "42" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistryVersion = vi.fn(async () => 1);

    const gw = new MolphaGateway("http://gw1", getRegistryVersion);
    const result = await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
      context: { registryVersion: 7, nodes, jobConfig },
    });

    expect(result.value).toBe("42");
    expect(result.registryVersion).toBe(7);
    // No on-chain registry read, and the only fetch is the /execute POST.
    expect(getRegistryVersion).not.toHaveBeenCalled();
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched).toEqual(["http://gw1/v1/jobs/" + JOB_ID + "/execute"]);
  });

  it("fetches only the fields missing from a partial context", async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({ status: "completed", value: "9" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistryVersion = vi.fn(async () => 3);

    const gw = new MolphaGateway("http://gw1", getRegistryVersion);
    const result = await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: { url: "http://api", responseParser: "$.price" },
      // nodes cached; registryVersion + jobConfig still fetched.
      context: { nodes },
    });

    expect(result.value).toBe("9");
    expect(getRegistryVersion).toHaveBeenCalledTimes(1);
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched).toContain("http://gw1/v1/jobs/" + JOB_ID + "/config");
    expect(fetched).not.toContain("http://gw1/v1/nodes");
  });

  it("prepareContext fetches all inputs once for reuse", async () => {
    globalThis.fetch = mockFetch(() =>
      jsonResponse({ status: "completed", value: "1" }),
    ) as unknown as typeof fetch;
    const getRegistryVersion = vi.fn(async () => 5);

    const gw = new MolphaGateway("http://gw1", getRegistryVersion);
    const ctx = await gw.prepareContext(JOB_ID);

    expect(ctx.registryVersion).toBe(5);
    expect(ctx.nodes).toEqual(nodes);
    expect(ctx.jobConfig).toEqual(jobConfig);
    expect(getRegistryVersion).toHaveBeenCalledTimes(1);
  });
});

describe("MolphaGateway.requestSignedData private API encryption node key verification", () => {
  it("throws by default when encrypt.secrets is used without a verifier", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistryVersion = vi.fn(async () => 1);

    const gw = new MolphaGateway("http://gw1", getRegistryVersion);
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
      }),
    ).rejects.toThrow(/requires authenticated node keys/);
    expect(getRegistryVersion).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows unverified encrypted node keys only with the explicit unsafe flag", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ status: "completed", value: "1" });
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
    });
    await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: {
        registryVersion: 1,
        nodes: [encryptedNodes[0]!],
        jobConfig,
      },
    });

    expect(postedBody?.encKeyBundle).toMatchObject({
      envelopes: expect.objectContaining({ "0": expect.any(String) }),
    });
  });

  it("proceeds when a verifier accepts the selected nodes", async () => {
    const verifyNodeKeys = vi.fn(async (_args: unknown) => undefined);
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ status: "completed", value: "1" });
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => 1, undefined, {
      verifyNodeKeys,
    });
    await gw.requestSignedData({
      jobId: JOB_ID,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: {
        registryVersion: 1,
        nodes: encryptedNodes,
        jobConfig: encryptedJobConfig,
      },
    });

    expect(verifyNodeKeys).toHaveBeenCalledTimes(1);
    expect(verifyNodeKeys.mock.calls[0]?.[0]).toMatchObject({
      jobId: JOB_ID,
      registryVersion: 1,
      selectedIndexes: [0, 1, 2],
      selectedNodes: encryptedNodes,
    });
    expect(postedBody?.encKeyBundle).toMatchObject({
      envelopes: expect.objectContaining({
        "0": expect.any(String),
        "1": expect.any(String),
        "2": expect.any(String),
      }),
    });
  });

  it("does not post the encrypted request when the verifier rejects", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const verifyNodeKeys = vi.fn(async () => {
      throw new Error("node key mismatch");
    });

    const gw = new MolphaGateway("http://gw1", async () => 1, undefined, {
      verifyNodeKeys,
    });
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          nodes: [encryptedNodes[0]!],
          jobConfig,
        },
      }),
    ).rejects.toThrow(/node key mismatch/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate selected node indexes before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const duplicateNodes = [
      encryptedNodes[0]!,
      { ...encryptedNodes[1]!, index: 0 },
    ];

    const gw = new MolphaGateway("http://gw1", async () => 1, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
    });
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          nodes: duplicateNodes,
          jobConfig: { signaturesRequired: 2, redundancyBuffer: 0, decimals: 8 },
        },
      }),
    ).rejects.toThrow(/duplicate node index/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate selected node public keys before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const duplicateKeyNodes = [
      encryptedNodes[0]!,
      { ...encryptedNodes[1]!, signingKey: encryptedNodes[0]!.signingKey },
    ];

    const gw = new MolphaGateway("http://gw1", async () => 1, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
    });
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          nodes: duplicateKeyNodes,
          jobConfig: { signaturesRequired: 2, redundancyBuffer: 0, decimals: 8 },
        },
      }),
    ).rejects.toThrow(/duplicate selected node signingKey/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid secp256k1 node public keys before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const invalidNodes = [{ ...encryptedNodes[0]!, signingKey: "02".padEnd(66, "0") }];

    const gw = new MolphaGateway("http://gw1", async () => 1, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
    });
    await expect(
      gw.requestSignedData({
        jobId: JOB_ID,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          nodes: invalidNodes,
          jobConfig,
        },
      }),
    ).rejects.toThrow(/invalid secp256k1 public key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
