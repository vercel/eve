import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestPublicUrl } from "#execution/web-fetch/request.js";

const networkMocks = vi.hoisted(() => ({
  agentClose: vi.fn(),
  agentOptions: [] as unknown[],
  fetch: vi.fn(),
  lookup: vi.fn(),
  socketAddresses: [] as unknown[],
}));

vi.mock("node:dns", () => ({
  lookup: networkMocks.lookup,
}));

vi.mock("undici", () => ({
  Agent: class MockAgent {
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
      networkMocks.agentOptions.push(options);
    }

    close(): Promise<void> {
      return networkMocks.agentClose();
    }
  },
}));

const REQUEST_OPTIONS = {
  headers: { Accept: "text/plain" },
  maxResponseSize: 100,
  signal: new AbortController().signal,
} as const;

interface MockResponse {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

beforeEach(() => {
  networkMocks.agentClose.mockReset();
  networkMocks.agentClose.mockResolvedValue(undefined);
  networkMocks.agentOptions.length = 0;
  networkMocks.fetch.mockReset();
  vi.stubGlobal("fetch", networkMocks.fetch);
  networkMocks.lookup.mockReset();
  networkMocks.lookup.mockImplementation(
    (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => callback(null, [{ address: "93.184.216.34", family: 4 }]),
  );
  networkMocks.socketAddresses.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestPublicUrl", () => {
  it("rejects HTTP and non-network URLs", async () => {
    for (const url of ["http://example.com", "file:///etc/passwd"]) {
      await expect(requestPublicUrl(url, REQUEST_OPTIONS), url).rejects.toThrow(
        "URL must start with https://",
      );
    }

    expect(networkMocks.lookup).not.toHaveBeenCalled();
    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects direct loopback, private, link-local, and address-translation targets", async () => {
    for (const url of [
      "https://127.0.0.1",
      "https://2130706433",
      "https://10.0.0.1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]",
      "https://[fc00::1]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:c0a8:1]",
      "https://[64:ff9b::a9fe:a9fe]",
    ]) {
      await expect(requestPublicUrl(url, REQUEST_OPTIONS), url).rejects.toThrow(
        "URL must not target localhost, private, link-local, or reserved IP addresses",
      );
    }

    expect(networkMocks.lookup).not.toHaveBeenCalled();
    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects localhost names before DNS resolution", async () => {
    for (const url of [
      "https://localhost",
      "https://localhost.",
      "https://service.localhost",
      "https://service.localhost.",
    ]) {
      await expect(requestPublicUrl(url, REQUEST_OPTIONS), url).rejects.toThrow(
        "URL must not target localhost",
      );
    }

    expect(networkMocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any resolved address is private", async () => {
    queueLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);
    queueResponse({});

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "URL must not target localhost, private, link-local, or reserved IP addresses",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
  });

  it("resolves and validates addresses inside the socket lookup", async () => {
    queueLookup([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    queueResponse({
      body: "public content",
      headers: { "content-type": "text/plain" },
    });

    const response = await requestPublicUrl("https://example.com/page", REQUEST_OPTIONS);

    expect(await response.text()).toBe("public content");
    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);

    const agentOptions = readAgentOptions(0);
    expect(agentOptions.connect.lookup).toBeTypeOf("function");
    expect(networkMocks.socketAddresses).toEqual([
      [
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        { address: "93.184.216.34", family: 4 },
      ],
    ]);
    expect(networkMocks.lookup).toHaveBeenCalledWith(
      "example.com",
      {
        all: true,
        verbatim: true,
      },
      expect.any(Function),
    );

    const [, fetchOptions] = networkMocks.fetch.mock.calls[0]!;
    expect(fetchOptions).toMatchObject({
      dispatcher: expect.anything(),
      redirect: "manual",
    });
  });

  it("returns private redirect targets without requesting them", async () => {
    queueResponse({
      headers: { location: "https://169.254.169.254/latest/meta-data" },
      status: 302,
    });

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "Request redirected to https://169.254.169.254/latest/meta-data. Call web_fetch again",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
    expect(networkMocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects that downgrade to HTTP", async () => {
    queueResponse({
      headers: { location: "http://example.com/insecure" },
      status: 302,
    });

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "URL must start with https://",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
    expect(networkMocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("returns an absolute HTTPS redirect target for agent follow-up", async () => {
    queueResponse({
      headers: { location: "/article" },
      status: 301,
    });

    await expect(requestPublicUrl("https://example.com/start", REQUEST_OPTIONS)).rejects.toThrow(
      "Request redirected to https://example.com/article. Call web_fetch again with that URL.",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
    expect(networkMocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects declared and streamed bodies over the response limit", async () => {
    queueResponse({
      headers: { "content-length": "101" },
    });

    await expect(requestPublicUrl("https://example.com/declared", REQUEST_OPTIONS)).rejects.toThrow(
      "Response too large",
    );

    queueResponse({
      body: "x".repeat(101),
    });

    await expect(requestPublicUrl("https://example.com/streamed", REQUEST_OPTIONS)).rejects.toThrow(
      "Response too large",
    );

    expect(networkMocks.agentClose).toHaveBeenCalledTimes(2);
  });
});

function queueResponse(response: MockResponse): void {
  networkMocks.fetch.mockImplementationOnce(async (input: URL, options: RequestInit) => {
    await connectThroughDispatcher(input, options);
    return new Response(response.body ?? "", {
      headers: response.headers,
      status: response.status ?? 200,
    });
  });
}

function queueLookup(addresses: LookupAddress[]): void {
  networkMocks.lookup.mockImplementationOnce(
    (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => callback(null, addresses),
  );
}

function readAgentOptions(index: number): { connect: { lookup?: LookupFunction } } {
  return networkMocks.agentOptions[index] as { connect: { lookup?: LookupFunction } };
}

function runLookup(publicLookup: LookupFunction | undefined, hostname: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    expect(publicLookup).toBeTypeOf("function");

    publicLookup!(hostname, { all: true }, (error, addresses) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(addresses);
    });
  });
}

async function connectThroughDispatcher(input: URL, options: RequestInit): Promise<void> {
  const hostname = input.hostname.replace(/^\[(.*)\]$/u, "$1");
  if (isIP(hostname) !== 0) {
    return;
  }

  const dispatcher = (options as RequestInit & { dispatcher: { options: unknown } }).dispatcher;
  const agentOptions = dispatcher.options as { connect: { lookup?: LookupFunction } };
  const addresses = await runLookup(agentOptions.connect.lookup, hostname);
  networkMocks.socketAddresses.push(addresses);
}
