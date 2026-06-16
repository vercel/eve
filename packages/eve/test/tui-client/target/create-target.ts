import type { TestTarget, TestTargetCapabilities, TestTargetKind } from "./types.ts";

export interface CreateTestTargetInput {
  readonly app: string;
  readonly baseUrl: string;
  readonly capabilities: TestTargetCapabilities;
  readonly kind: TestTargetKind;
  readonly stop: () => Promise<void>;
}

export function createTestTarget(input: CreateTestTargetInput): TestTarget {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const capabilities = freezeTestTargetCapabilities(input.capabilities);
  let stopPromise: Promise<void> | undefined;

  return {
    app: input.app,
    baseUrl,
    capabilities,
    kind: input.kind,
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        await input.stop();
      })();
      return stopPromise;
    },
  };
}

function freezeTestTargetCapabilities(
  capabilities: TestTargetCapabilities,
): TestTargetCapabilities {
  return Object.freeze({
    devRoutes: capabilities.devRoutes,
    localBuildOutput: capabilities.localBuildOutput,
    mutableStartupEnv: capabilities.mutableStartupEnv,
    ownedProcess: capabilities.ownedProcess,
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Smoke target base URL must use http: or https: protocol: ${baseUrl}.`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}
