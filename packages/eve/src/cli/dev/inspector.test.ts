import { describe, expect, it, vi } from "vitest";

import {
  openDevInspector,
  resolveDevInspectorRequest,
  type DevInspectorRequest,
} from "./inspector.js";

describe("resolveDevInspectorRequest", () => {
  it("resolves the default inspector target", () => {
    expect(resolveDevInspectorRequest({ inspect: true })).toEqual({
      host: "127.0.0.1",
      mode: "inspect",
      port: 9229,
    });
  });

  it("resolves port-only and host-port targets", () => {
    expect(resolveDevInspectorRequest({ inspect: "9230" })).toMatchObject({
      host: "127.0.0.1",
      port: 9230,
    });
    expect(resolveDevInspectorRequest({ inspectWait: "localhost:0" })).toMatchObject({
      host: "localhost",
      mode: "inspect-wait",
      port: 0,
    });
  });

  it("resolves non-loopback hosts", () => {
    expect(resolveDevInspectorRequest({ inspect: "0.0.0.0:9229" })).toMatchObject({
      host: "0.0.0.0",
      mode: "inspect",
      port: 9229,
    });
  });

  it("rejects multiple modes and malformed targets", () => {
    expect(() => resolveDevInspectorRequest({ inspect: true, inspectBrk: true })).toThrow(
      "Use only one",
    );
    expect(() => resolveDevInspectorRequest({ inspect: "host" })).toThrow("host:port");
    expect(() => resolveDevInspectorRequest({ inspect: "127.0.0.1:65536" })).toThrow(
      "between 0 and 65535",
    );
    expect(() => resolveDevInspectorRequest({ inspect: "[::1]:9229" })).toThrow(
      "IPv6 inspector targets",
    );
  });
});

describe("openDevInspector", () => {
  it("opens with wait disabled and returns the inspector URL", async () => {
    const api = createInspectorApi();
    const request: DevInspectorRequest = {
      host: "127.0.0.1",
      mode: "inspect",
      port: 9229,
    };

    const handle = await openDevInspector(request, api);

    expect(api.open).toHaveBeenCalledWith(9229, "127.0.0.1", false);
    expect(handle.url).toBe("ws://127.0.0.1:9229/session");
  });

  it("waits and closes through the inspector API fallback", async () => {
    const api = createInspectorApi({ openReturn: undefined });
    const handle = await openDevInspector(
      {
        host: "127.0.0.1",
        mode: "inspect-wait",
        port: 0,
      },
      api,
    );

    handle.waitForDebugger();
    handle.close();
    handle.close();

    expect(api.waitForDebugger).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});

function createInspectorApi(options: { readonly openReturn?: unknown } = {}) {
  return {
    close: vi.fn(),
    open: vi.fn(() => options.openReturn),
    url: vi.fn(() => "ws://127.0.0.1:9229/session"),
    waitForDebugger: vi.fn(),
  };
}
