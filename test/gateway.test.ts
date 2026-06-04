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

    const gw = new MolphaGateway("http://gw1");
    const result = await gw.execute({
      jobId: JOB_ID,
      registryVersion: 1,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });
    expect(result.value).toBe("100");
    expect(result.commitmentAddr).toBe("bb".repeat(20));
  });

  it("throws immediately on 400 without trying the next endpoint", async () => {
    const handler = vi.fn(() => jsonResponse({ error: "bad" }, 400));
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"]);
    await expect(
      gw.execute({
        jobId: JOB_ID,
        registryVersion: 1,
        maxRetries: 3,
        apiConfig: { url: "http://api", responseParser: "$.price" },
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(handler).toHaveBeenCalledTimes(1); // did not fall through
  });

  it("falls through 503 to the next endpoint", async () => {
    const handler = vi.fn((url: string) =>
      url.startsWith("http://gw1")
        ? jsonResponse({ error: "busy" }, 503)
        : jsonResponse({ status: "completed", value: "7" }),
    );
    globalThis.fetch = mockFetch(handler) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"]);
    const result = await gw.execute({
      jobId: JOB_ID,
      registryVersion: 1,
      apiConfig: { url: "http://api", responseParser: "$.price" },
    });
    expect(result.value).toBe("7");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
