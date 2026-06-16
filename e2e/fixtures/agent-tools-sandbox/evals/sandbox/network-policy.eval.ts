import { defineEval } from "eve/evals";

// Distinguishes a real egress block from curl simply being absent: a blocked
// request fails with a resolution/connection error, never "command not found".
const NETWORK_FAILURE =
  /could ?n['o]t resolve|resolve host|could ?n['o]t connect|failed to connect|connection refused|network is unreachable|couldn't resolve host/i;

function isBlocked(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.blocked === true &&
    typeof record.exitCode === "number" &&
    record.exitCode !== 0 &&
    typeof record.stderr === "string" &&
    NETWORK_FAILURE.test(record.stderr)
  );
}

// `network-probe` applies a deny-all policy to the live sandbox mid-turn and
// then attempts egress. Asserting the probe came back blocked proves
// `setNetworkPolicy("deny-all")` actually severs egress on the active backend.
export default defineEval({
  description: "Sandbox: setNetworkPolicy('deny-all') blocks sandbox egress mid-turn.",
  async test(t) {
    const turn = await t.send(
      "Use the `network-probe` tool and tell me whether sandbox network egress was blocked.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("network-probe", {
      isError: false,
      output: isBlocked,
    });
  },
});
