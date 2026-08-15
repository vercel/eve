import { resolve } from "node:path";

import { build as buildNitro, prepare } from "nitro/builder";
import type { Nitro } from "nitro/types";

import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

const CANDIDATE_BUILD_TIMEOUT_MS = 120_000;

export interface DevelopmentWorkerPayload {
  readonly entry: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

/**
 * Builds one host candidate in its invocation-owned workspace and returns the
 * worker payload Nitro emitted for it. The Nitro instance is closed before
 * returning: the payload's entry lives on disk in the workspace, so nothing
 * retains the builder.
 */
export async function buildDevelopmentHostCandidate(input: {
  readonly host: PreparedDevelopmentApplicationHost;
  readonly nitro: Nitro;
}): Promise<DevelopmentWorkerPayload> {
  const nitro = input.nitro;
  let settled = false;
  let payload: DevelopmentWorkerPayload | undefined;
  let buildError: unknown;
  let signal: (() => void) | undefined;
  const signalled = new Promise<void>((resolve) => {
    signal = resolve;
  });

  const removeReloadHook = nitro.hooks.hook("dev:reload", (reload) => {
    if (settled) {
      return;
    }
    settled = true;
    // Stock Nitro falls back to the configured output entry when the reload
    // payload does not carry one.
    payload = {
      entry:
        reload?.entry ??
        resolve(nitro.options.output.dir, nitro.options.output.serverDir, "index.mjs"),
      workerData: reload?.workerData ?? {},
    };
    signal?.();
  });
  const removeErrorHook = nitro.hooks.hook("dev:error", (cause) => {
    if (settled) {
      return;
    }
    settled = true;
    buildError = cause;
    signal?.();
  });

  try {
    await prepare(nitro);
    await buildNitro(nitro);
    await waitForSignal(signalled);
    if (buildError !== undefined) {
      throw buildError instanceof Error ? buildError : new Error(String(buildError));
    }
    if (payload === undefined || payload.entry.length === 0) {
      throw new Error("Nitro did not emit a development worker entry.");
    }
    return payload;
  } finally {
    removeReloadHook();
    removeErrorHook();
    await nitro.close().catch(() => undefined);
  }
}

async function waitForSignal(signalled: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signalled,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the Nitro dev build to emit a worker.")),
          CANDIDATE_BUILD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
