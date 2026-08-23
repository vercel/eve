import { defineEval } from "eve/evals";

interface ProbeResult {
  readonly firstBody?: unknown;
  readonly firstStatus?: unknown;
  readonly mode?: unknown;
  readonly secondBody?: unknown;
  readonly secondStatus?: unknown;
  readonly supported?: unknown;
}

export default defineEval({
  description:
    "Sandbox: an on-request egress route fails fast with 428, eve settles the demanded credential after the command exits, and the retried request succeeds.",
  timeoutMs: 120_000,
  async test(t) {
    const probe = await t.send(
      "Use the `on-request-probe` tool exactly once. Report its result without calling other tools.",
    );
    probe.expectOk();

    const probeCall = probe.toolCalls.find((call) => call.name === "on-request-probe");
    if (probeCall === undefined) {
      throw new Error(`on-request-probe did not complete successfully: ${JSON.stringify(probe)}`);
    }
    assertProbeResult(probeCall.output, t.target.kind);
  },
});

function assertProbeResult(value: unknown, targetKind: "local" | "remote"): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Unexpected on-request probe output: ${JSON.stringify(value)}`);
  }
  const result = value as ProbeResult;
  if (targetKind === "local") {
    if (result.mode !== "local" || result.supported !== false) {
      throw new Error(
        `Local on-request probe was not explicitly unsupported: ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (result.mode !== "vercel" || result.supported !== true) {
    throw new Error(`Vercel on-request probe did not run: ${JSON.stringify(value)}`);
  }
  if (result.firstStatus !== 428) {
    throw new Error(
      `First request should fail fast with the egress proxy's 428: ${JSON.stringify(value)}`,
    );
  }
  if (result.secondStatus !== 200 || result.secondBody !== '{"authorized":true}') {
    throw new Error(
      `Retried request should succeed with the settled credential: ${JSON.stringify(value)}`,
    );
  }
}
