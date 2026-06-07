import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError, MolphaGateway } from "../src/gateway/index.js";

const JOB_ID = "11".repeat(32);

const nodes = [
  { index: 0, peerId: "a", address: "n0", signingKey: "02".padEnd(66, "0") },
  { index: 1, peerId: "b", address: "n1", signingKey: "03".padEnd(66, "0") },
  { index: 2, peerId: "c", address: "n2", signingKey: "02".padEnd(66, "1") },
];
const jobConfig = { signaturesRequired: 1, redundancyBuffer: 0, decimals: 8 };

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

describe("MolphaGateway.execute failover", () => {
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
    const result = await gw.execute({
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
    const result = await gw.execute({
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
      gw.execute({
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
    const result = await gw.execute({
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
      gw.execute({
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

describe("MolphaGateway.execute cached context (short flow)", () => {
  it("skips the prelude fetches when a full context is supplied", async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({ status: "completed", value: "42" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistryVersion = vi.fn(async () => 1);

    const gw = new MolphaGateway("http://gw1", getRegistryVersion);
    const result = await gw.execute({
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
    const result = await gw.execute({
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
