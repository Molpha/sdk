import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "../src/core/encoding.js";
import { GatewayError, MolphaGateway } from "../src/gateway/index.js";

const FEED_ID = "11".repeat(32);
const SUBSCRIPTION_OWNER = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";

const nodes = [
  { index: 0, peerId: "a", address: "n0", signingKey: "02".padEnd(66, "0") },
  { index: 1, peerId: "b", address: "n1", signingKey: "03".padEnd(66, "0") },
  { index: 2, peerId: "c", address: "n2", signingKey: "02".padEnd(66, "1") },
];
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes GETs to nodes and lets the test control each /execute POST. */
function mockFetch(executeHandler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/execute")) return executeHandler(url);
    if (url.endsWith("/nodes")) return jsonResponse(nodes);
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const baseRequest = {
  feedId: FEED_ID,
  signaturesRequired: 1,
  apiConfig: { url: "http://api", responseParser: "$.price" },
  subscriptionOwner: SUBSCRIPTION_OWNER,
};

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

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    const result = await gw.requestSignedData(baseRequest);
    expect(result.value).toBe("100");
    expect(result.commitmentAddr).toBe("bb".repeat(20));
  });

  it("throws when subscriptionOwner is missing", async () => {
    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    await expect(
      gw.requestSignedData({
        feedId: FEED_ID,
        signaturesRequired: 1,
        apiConfig: { url: "http://api", responseParser: "$.price" },
      }),
    ).rejects.toThrow("subscriptionOwner is required");
  });

  it("throws immediately on 400 without trying the next endpoint", async () => {
    const handler = vi.fn(() => jsonResponse({ error: "bad" }, 400));
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    await expect(
      gw.requestSignedData({
        ...baseRequest,
        maxRetries: 3,
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

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    const result = await gw.requestSignedData(baseRequest);
    expect(result.value).toBe("7");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns 503 details when all endpoints fail", async () => {
    const handler = vi.fn(() =>
      jsonResponse({ error: "group size 4 exceeds total node count 3" }, 503),
    );
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    await expect(
      gw.requestSignedData({
        ...baseRequest,
        maxRetries: 1,
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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/execute")) {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ status: "completed", value: "1" });
      }
      if (url.endsWith("/nodes")) return jsonResponse(nodes);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      "http://gw1",
      async () => ({ registryVersion: 1, redundancyBuffer: 2 }),
      defaultSigner,
      SUBSCRIPTION_OWNER,
    );
    await gw.requestSignedData({
      feedId: FEED_ID,
      signaturesRequired: 1,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });

    expect(defaultSigner).toHaveBeenCalledTimes(1);
    expect(postedBody?.authSig).toBe("0x" + "ab".repeat(64));
    expect(postedBody?.subscriptionOwner).toBe(SUBSCRIPTION_OWNER);
    expect(postedBody?.consumerAuthority).toBe(SUBSCRIPTION_OWNER);
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
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      "http://gw1",
      async () => ({ registryVersion: 1, redundancyBuffer: 2 }),
      defaultSigner,
      SUBSCRIPTION_OWNER,
    );
    await gw.requestSignedData({
      feedId: FEED_ID,
      signaturesRequired: 1,
      apiConfig: { url: "http://api", responseParser: "$.price" },
      signer: overrideSigner,
    });

    expect(defaultSigner).not.toHaveBeenCalled();
    expect(overrideSigner).toHaveBeenCalledTimes(1);
    expect(postedBody?.authSig).toBe("0x" + "cd".repeat(64));
  });
});

describe("MolphaGateway.requestSignedData cached context (short flow)", () => {
  it("skips the prelude fetches when a full context is supplied", async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({ status: "completed", value: "42" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 1, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const result = await gw.requestSignedData({
      ...baseRequest,
      context: { registryVersion: 7, redundancyBuffer: 2, nodes },
    });

    expect(result.value).toBe("42");
    expect(result.registryVersion).toBe(7);
    // No on-chain registry read, and the only fetch is the /execute POST.
    expect(getRegistrySelectionConfig).not.toHaveBeenCalled();
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched).toEqual(["http://gw1/v1/round/execute"]);
  });

  it("fetches only the fields missing from a partial context", async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({ status: "completed", value: "9" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 3, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const result = await gw.requestSignedData({
      ...baseRequest,
      // nodes cached; registry selection config still fetched.
      context: { nodes },
    });

    expect(result.value).toBe("9");
    expect(getRegistrySelectionConfig).toHaveBeenCalledTimes(1);
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched).not.toContain("http://gw1/v1/nodes");
  });

  it("prepareContext fetches all inputs once for reuse", async () => {
    globalThis.fetch = mockFetch(() =>
      jsonResponse({ status: "completed", value: "1" }),
    ) as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 5, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const ctx = await gw.prepareContext(FEED_ID);

    expect(ctx.registryVersion).toBe(5);
    expect(ctx.redundancyBuffer).toBe(2);
    expect(ctx.nodes).toEqual(nodes);
    expect(getRegistrySelectionConfig).toHaveBeenCalledTimes(1);
  });

  it("uses the cached redundancyBuffer for selection size", async () => {
    const verifyNodeKeys = vi.fn(async (_args: unknown) => undefined);
    globalThis.fetch = mockFetch(() =>
      jsonResponse({ status: "completed", value: "1" }),
    ) as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({
      registryVersion: 1,
      redundancyBuffer: 2,
    }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig, undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      feedId: FEED_ID,
      signaturesRequired: 1,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: {
        registryVersion: 1,
        // On-chain buffer lowered to 0 — select only signaturesRequired nodes.
        redundancyBuffer: 0,
        nodes: encryptedNodes,
      },
    });

    expect(getRegistrySelectionConfig).not.toHaveBeenCalled();
    expect(verifyNodeKeys.mock.calls[0]?.[0]).toMatchObject({
      selectedIndexes: expect.any(Array),
    });
    expect((verifyNodeKeys.mock.calls[0]?.[0] as { selectedIndexes: number[] }).selectedIndexes)
      .toHaveLength(1);
  });
});

describe("MolphaGateway.requestSignedData private API encryption node key verification", () => {
  it("throws by default when encrypt.secrets is used without a verifier", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 1, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    await expect(
      gw.requestSignedData({
        feedId: FEED_ID,
        signaturesRequired: 1,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
      }),
    ).rejects.toThrow(/requires authenticated node keys/);
    expect(getRegistrySelectionConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows unverified encrypted node keys only with the explicit unsafe flag", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ status: "completed", value: "1" });
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }), undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      feedId: FEED_ID,
      signaturesRequired: 1,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: {
        registryVersion: 1,
        redundancyBuffer: 2,
        nodes: [encryptedNodes[0]!],
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

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }), undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      feedId: FEED_ID,
      signaturesRequired: 3,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: {
        registryVersion: 1,
        redundancyBuffer: 2,
        nodes: encryptedNodes,
      },
    });

    expect(verifyNodeKeys).toHaveBeenCalledTimes(1);
    expect(verifyNodeKeys.mock.calls[0]?.[0]).toMatchObject({
      feedId: FEED_ID,
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

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }), undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        feedId: FEED_ID,
        signaturesRequired: 1,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          redundancyBuffer: 2,
          nodes: [encryptedNodes[0]!],
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

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }), undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        feedId: FEED_ID,
        signaturesRequired: 2,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          redundancyBuffer: 2,
          nodes: duplicateNodes,
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

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }), undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        feedId: FEED_ID,
        signaturesRequired: 2,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          redundancyBuffer: 2,
          nodes: duplicateKeyNodes,
        },
      }),
    ).rejects.toThrow(/duplicate selected node signingKey/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid secp256k1 node public keys before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const invalidNodes = [{ ...encryptedNodes[0]!, signingKey: "02".padEnd(66, "0") }];

    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }), undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        feedId: FEED_ID,
        signaturesRequired: 1,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: {
          registryVersion: 1,
          redundancyBuffer: 2,
          nodes: invalidNodes,
        },
      }),
    ).rejects.toThrow(/invalid secp256k1 public key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
