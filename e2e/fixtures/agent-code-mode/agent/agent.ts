import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

/**
 * Deterministic script: each directive names the program `code_mode` should
 * run; once the turn holds the `code_mode` result the reply echoes it.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = [...request.userMessages].reverse().find((entry) => entry.trim() !== "") ?? "";
  let result: MockModelRequest["toolResults"][number] | undefined;
  const echo = (): string =>
    `${directive}-RESULT ${
      typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? null)
    }`;

  let directive = "";
  let js: string | undefined;
  if (message.includes("CODEMODE-VISIBILITY-CHILD")) {
    return request.tools.some((tool) => tool.name === "code_mode" || tool.name === "Workflow")
      ? "CHILD_WRAPPER_VISIBLE"
      : "CHILD_WRAPPER_ABSENT";
  } else if (message.includes("CODEMODE-VISIBILITY-START")) {
    directive = "CODEMODE-VISIBILITY";
    js = 'return await tools.agent({ message: "CODEMODE-VISIBILITY-CHILD" });';
  } else if (message.includes("CODEMODE-LIMIT-START")) {
    directive = "CODEMODE-LIMIT";
    js =
      'const results = []; for (const message of ["limit-alpha", "limit-beta", "limit-gamma"]) { try { results.push(await tools.marker({ message })); } catch (error) { results.push(String(error)); } } return results;';
  } else if (message.includes("CODEMODE-CONTINUE-START")) {
    directive = "CODEMODE-CONTINUE";
    js = 'return await tools.marker({ message: "first" });';
  } else if (message.includes("CODEMODE-RESUME-START")) {
    directive = "CODEMODE-RESUME";
    const listing = request.messages.map((entry) => entry.text).join("\n");
    const agentId = /<agent id="([^"]+)" name="marker"(?: [^>]*)?>/u.exec(listing)?.[1];
    if (agentId === undefined) throw new Error("No marker agent id in the parent announcement.");
    js = `const agentId = ${JSON.stringify(agentId)}; const results = []; for (const message of ["second", "third", "excess"]) { try { results.push(await tools.marker({ agentId, message })); } catch (error) { results.push(String(error)); } } return results;`;
  } else if (message.includes("CODEMODE-ECHO-START")) {
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
  } else if (message.includes("CODEMODE-DYNAMIC-START")) {
    directive = "CODEMODE-DYNAMIC";
    js = "return { shared: await tools.shared({}), discovered: await tools.discovered({}) };";
  } else if (message.includes("CODEMODE-DISCOVERY-START")) {
    directive = "CODEMODE-DISCOVERY";
    const direct = request.tools.map((tool) => tool.name).sort();
    js = [
      "const catalog = await tools.search_tools({});",
      "const direct = catalog.filter(tool => tool.requiresDirectCall).map(tool => tool.name).sort();",
      `const complete = JSON.stringify(direct) === JSON.stringify(${JSON.stringify(direct)});`,
      'const schemas = await tools.describe_tools({ names: ["background", "connection_search", "gated"] });',
      'return { complete, schemas: schemas.every(tool => tool.requiresDirectCall && tool.inputSchema.type === "object") };',
    ].join("\n");
  } else if (message.includes("CODEMODE-CONNECTIONS-START")) {
    directive = "CODEMODE-CONNECTIONS";
    if (!request.toolResults.some((entry) => entry.name === "connection_search")) {
      return { toolCalls: [{ name: "connection_search", input: { keywords: "status" } }] };
    }
    if (request.tools.some((tool) => tool.name === "catalog__getStatus")) {
      throw new Error("Discovered never-approved connection tool stayed direct.");
    }
    // The inline spec tests discovery without making an external API request.
    js =
      'const [discovered] = await tools.describe_tools({ names: ["catalog__getStatus"] }); return { discovered: discovered.name, requiresDirectCall: discovered.requiresDirectCall, echo: await tools.echo({ value: "catalog-ready" }) };';
  } else if (message.includes("CODEMODE-AUTH-START")) {
    directive = "CODEMODE-AUTH";
    js =
      'const first = await tools.echo({ value: "before-auth" }); return { first, auth: await tools.authorize({}) };';
  } else if (message.includes("CODEMODE-FAILURE-START")) {
    directive = "CODEMODE-FAILURE";
    js = [
      'const results = await Promise.allSettled([tools.marker({ message: "FAIL-CHILD" }), tools.echo({ value: "sibling" })]);',
      'const retry = await tools.marker({ message: "retry-ok" });',
      "return { statuses: results.map(r => r.status), sibling: results[1].value, retry };",
    ].join("\n");
  } else if (message.includes("CODEMODE-SURFACE-START")) {
    const names = request.tools.map((tool) => tool.name).sort();
    return `CODEMODE-SURFACE-RESULT [${names.join(",")}]`;
  }

  if (js !== undefined) {
    result = request.toolResults.find((entry) => entry.id === directive);
    return result === undefined
      ? { toolCalls: [{ id: directive, input: { js }, name: "code_mode" }] }
      : echo();
  }
  return "CODEMODE-IDLE";
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, codeMode: { mode: "eager", maxSubagents: 2 } },
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
