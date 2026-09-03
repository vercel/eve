import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

/**
 * Deterministic script: each directive names the program `code_mode` should
 * run; once the turn holds the `code_mode` result the reply echoes it.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = [...request.userMessages].reverse().find((entry) => entry.trim() !== "") ?? "";
  const result = [...request.toolResults].reverse().find((entry) => entry.name === "code_mode");
  const echo = (): string =>
    `${directive}-RESULT ${
      typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? null)
    }`;

  let directive = "";
  let js: string | undefined;
  if (message.includes("CODEMODE-ECHO-START")) {
    directive = "CODEMODE-ECHO";
    js = 'return await tools.echo({ value: "hello" });';
  } else if (message.includes("CODEMODE-CHAIN-START")) {
    directive = "CODEMODE-CHAIN";
    js = [
      'const first = await tools.echo({ value: "one" });',
      "const second = await tools.echo({ value: first });",
      "return second;",
    ].join("\n");
  } else if (message.includes("CODEMODE-FANOUT-START")) {
    directive = "CODEMODE-FANOUT";
    js = [
      "const [a, b, c] = await Promise.all([",
      '  tools.marker({ message: "replica-0" }),',
      '  tools.marker({ message: "replica-1" }),',
      '  tools.echo({ value: "inline" }),',
      "]);",
      "return { a, b, c };",
    ].join("\n");
  } else if (message.includes("CODEMODE-SURFACE-START")) {
    const names = request.tools.map((tool) => tool.name).sort();
    return `CODEMODE-SURFACE-RESULT [${names.join(",")}]`;
  }

  if (js !== undefined) {
    return result === undefined ? { toolCalls: [{ input: { js }, name: "code_mode" }] } : echo();
  }
  return "CODEMODE-IDLE";
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, codeMode: "eager" },
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
