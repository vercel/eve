import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import { installLocalInstrumentationRuntime } from "#harness/local-instrumentation-runtime.js";

let appRoot: string | undefined;

afterEach(async () => {
  if (appRoot !== undefined) await rm(appRoot, { force: true, recursive: true });
});

describe("local instrumentation runtime ownership", () => {
  it("fails loudly when another global tracer provider already exists", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-conflict-"));
    expect(trace.setGlobalTracerProvider(new BasicTracerProvider())).toBe(true);

    expect(() =>
      installLocalInstrumentationRuntime({
        appRoot: appRoot!,
        frameworkVersion: "test",
        serviceName: "test-agent",
      }),
    ).toThrow(/another runtime already exists/u);
  });
});
