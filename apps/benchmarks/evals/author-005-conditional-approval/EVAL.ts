import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

const toolPath = "agent/tools/refund_payment.ts";

test("creates a typed refund tool that returns both values", async () => {
  expect(existsSync(toolPath)).toBe(true);
  expect(readFileSync(toolPath, "utf8")).toMatch(/defineTool\s*\(/);

  const definition = await loadDefinition();
  const input = refundInput(definition, 42);
  const output = await definition.execute(input, {});
  expect(JSON.stringify(output)).toContain("pay_123");
  expect(JSON.stringify(output)).toContain("42");
  expect(() => refundInput(definition, 0)).toThrow();
});

test("requires approval only at or above the threshold", async () => {
  const definition = await loadDefinition();
  const policy =
    typeof definition.approval === "function" ? definition.approval : definition.approval?.request;
  expect(typeof policy).toBe("function");

  const decision = async (amount: number) =>
    policy({
      approvedTools: new Set(),
      callId: "refund-call",
      session: {},
      toolInput: refundInput(definition, amount),
      toolName: "refund_payment",
    });

  expect(requiresApproval(await decision(99))).toBe(false);
  expect(requiresApproval(await decision(100))).toBe(true);
});

function requiresApproval(decision: unknown): boolean {
  if (decision === true || decision === "user-approval") return true;
  return (
    typeof decision === "object" &&
    decision !== null &&
    "type" in decision &&
    decision.type === "user-approval"
  );
}

async function loadDefinition() {
  return (await import(new URL("../agent/tools/refund_payment.ts", import.meta.url).href)).default;
}

function refundInput(definition: Awaited<ReturnType<typeof loadDefinition>>, amount: number) {
  for (const input of [
    { paymentId: "pay_123", amount },
    { paymentId: "pay_123", amountUsd: amount },
  ]) {
    const parsed = definition.inputSchema.safeParse(input);
    if (parsed.success) return parsed.data;
  }
  throw new Error(`The refund schema rejected amount ${amount}.`);
}
