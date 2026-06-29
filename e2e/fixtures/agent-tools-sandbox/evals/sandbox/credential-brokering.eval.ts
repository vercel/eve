import { defineEval } from "eve/evals";

interface ProbeResult {
  readonly authorized?: unknown;
  readonly credentialVisibleToProcess?: unknown;
  readonly httpStatus?: unknown;
  readonly mode?: unknown;
  readonly supported?: unknown;
}

interface CleanupResult {
  readonly blockedAfterStep?: unknown;
  readonly mode?: unknown;
  readonly supported?: unknown;
}

export default defineEval({
  description:
    "Sandbox: Vercel firewall injects brokered credentials, keeps them out of the process, and clears them after the step.",
  timeoutMs: 90_000,
  async test(t) {
    const probe = await t.send(
      "Use the `credential-probe` tool exactly once. Report its result without calling other tools.",
    );
    probe.expectOk();

    const probeCall = probe.toolCalls.find((call) => call.name === "credential-probe");
    if (probeCall === undefined) {
      throw new Error(`credential-probe did not complete successfully: ${JSON.stringify(probe)}`);
    }
    assertProbeResult(probeCall.output, t.target.kind);

    if (t.target.kind === "remote") {
      await t.sleep(9_000);
      const cleanup = await t.send(
        "Use the `credential-probe-cleanup` tool exactly once. Report its result without calling other tools.",
      );
      cleanup.expectOk();
      const cleanupCall = cleanup.toolCalls.find(
        (call) => call.name === "credential-probe-cleanup",
      );
      if (cleanupCall === undefined) {
        throw new Error(
          `credential-probe-cleanup did not complete successfully: ${JSON.stringify(cleanup)}`,
        );
      }
      assertCleanupResult(cleanupCall.output);
    }
  },
});

function assertProbeResult(value: unknown, targetKind: "local" | "remote"): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Unexpected credential probe output: ${JSON.stringify(value)}`);
  }
  const result = value as ProbeResult;
  if (targetKind === "local") {
    if (result.mode !== "local" || result.supported !== false) {
      throw new Error(
        `Local credential probe was not explicitly unsupported: ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (
    result.mode !== "vercel" ||
    result.supported !== true ||
    result.authorized !== true ||
    result.credentialVisibleToProcess !== false
  ) {
    throw new Error(`Vercel credential brokering probe failed: ${JSON.stringify(value)}`);
  }
}

function assertCleanupResult(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Unexpected credential cleanup output: ${JSON.stringify(value)}`);
  }
  const result = value as CleanupResult;
  if (result.mode !== "vercel" || result.supported !== true || result.blockedAfterStep !== true) {
    throw new Error(`Vercel credential cleanup probe failed: ${JSON.stringify(value)}`);
  }
}
