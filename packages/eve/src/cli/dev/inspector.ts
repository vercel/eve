import * as inspector from "node:inspector";

import { InvalidArgumentError } from "#compiled/commander/index.js";

const DEFAULT_INSPECTOR_HOST = "127.0.0.1";
const DEFAULT_INSPECTOR_PORT = 9229;

export type DevInspectorMode = "inspect" | "inspect-wait" | "inspect-brk";

export interface DevInspectorRequest {
  readonly host: string;
  readonly mode: DevInspectorMode;
  readonly port: number;
}

export interface DevInspectorHandle {
  readonly mode: DevInspectorMode;
  readonly url: string;
  close(): void;
  waitForDebugger(): void;
}

export interface DevInspectorApi {
  close(): void;
  open(port?: number, host?: string, wait?: boolean): unknown;
  url(): string | undefined;
  waitForDebugger(): void;
}

export function resolveDevInspectorRequest(input: {
  readonly inspect?: string | boolean;
  readonly inspectBrk?: string | boolean;
  readonly inspectWait?: string | boolean;
}): DevInspectorRequest | undefined {
  const candidates: ReadonlyArray<{
    readonly mode: DevInspectorMode;
    readonly value: string | boolean | undefined;
  }> = [
    { mode: "inspect", value: input.inspect },
    { mode: "inspect-brk", value: input.inspectBrk },
    { mode: "inspect-wait", value: input.inspectWait },
  ];
  const entries = candidates.filter((entry) => entry.value !== undefined);

  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length > 1) {
    throw new InvalidArgumentError("Use only one of --inspect, --inspect-wait, or --inspect-brk.");
  }

  const [entry] = entries;
  const target = parseDevInspectorTarget(entry!.value);
  return {
    ...target,
    mode: entry!.mode,
  };
}

export async function openDevInspector(
  request: DevInspectorRequest,
  api: DevInspectorApi = inspector,
): Promise<DevInspectorHandle> {
  const disposable = api.open(request.port, request.host, false);
  const url = api.url();

  if (url === undefined) {
    throw new Error("Node inspector opened without reporting an attach URL.");
  }

  let closed = false;
  return {
    mode: request.mode,
    url,
    close() {
      if (closed) {
        return;
      }

      closed = true;
      disposeInspectorHandle(disposable, api);
    },
    waitForDebugger() {
      api.waitForDebugger();
    },
  };
}

function parseDevInspectorTarget(value: string | boolean | undefined): {
  readonly host: string;
  readonly port: number;
} {
  if (value === undefined || value === true) {
    return { host: DEFAULT_INSPECTOR_HOST, port: DEFAULT_INSPECTOR_PORT };
  }

  if (value === false) {
    throw new InvalidArgumentError("Inspector target cannot be false.");
  }

  const target = value.trim();
  if (target.length === 0) {
    throw new InvalidArgumentError("Inspector target cannot be empty.");
  }

  if (/^\d+$/u.test(target)) {
    return { host: DEFAULT_INSPECTOR_HOST, port: parseDevInspectorPort(target) };
  }

  if (target.startsWith("[") || target.includes("]:")) {
    throw new InvalidArgumentError(
      "Bracketed IPv6 inspector targets are not supported; use a hostname, IPv4 address, or port.",
    );
  }

  const separator = target.indexOf(":");
  if (separator === -1 || separator !== target.lastIndexOf(":")) {
    throw new InvalidArgumentError(
      `Expected inspector target to be a port or host:port, received "${value}".`,
    );
  }

  const host = target.slice(0, separator);
  const port = target.slice(separator + 1);

  if (host.length === 0 || port.length === 0) {
    throw new InvalidArgumentError(
      `Expected inspector target to be a port or host:port, received "${value}".`,
    );
  }

  return {
    host,
    port: parseDevInspectorPort(port),
  };
}

function parseDevInspectorPort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError(`Expected inspector port to be numeric, received "${value}".`);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError(
      `Expected inspector port between 0 and 65535, received "${value}".`,
    );
  }

  return port;
}

function disposeInspectorHandle(disposable: unknown, api: DevInspectorApi): void {
  if (disposable !== undefined && disposable !== null && typeof disposable === "object") {
    const symbolDispose = (Symbol as { readonly dispose?: symbol }).dispose;
    if (symbolDispose !== undefined) {
      const dispose = (disposable as Record<symbol, unknown>)[symbolDispose];
      if (typeof dispose === "function") {
        dispose.call(disposable);
        return;
      }
    }
  }

  api.close();
}
