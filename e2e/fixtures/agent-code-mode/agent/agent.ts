import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

/**
 * Deterministic script covering code_mode programs and direct-only controls.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = [...request.userMessages].reverse().find((entry) => entry.trim() !== "") ?? "";
  if (message.includes("CODEMODE-PROGRAM-ERROR-START")) {
    const failed = request.toolResults.find((entry) => entry.id === "CODEMODE-INVALID");
    if (failed === undefined) {
      return {
        toolCalls: [
          {
            id: "CODEMODE-INVALID",
            name: "code_mode",
            input: {
              js: 'return await tools.echo({ value: "invalid" }));',
            },
          },
        ],
      };
    }
    if (!failed.isError) throw new Error("Invalid JavaScript did not produce a tool error.");
    const corrected = request.toolResults.find((entry) => entry.id === "CODEMODE-CORRECTED");
    return corrected === undefined
      ? {
          toolCalls: [
            {
              id: "CODEMODE-CORRECTED",
              name: "code_mode",
              input: {
                js: 'return await tools.echo({ value: "corrected" });',
              },
            },
          ],
        }
      : `CODEMODE-PROGRAM-ERROR-RESULT ${corrected.output}`;
  }
  let result: MockModelRequest["toolResults"][number] | undefined;
  const echo = (): string =>
    `${directive}-RESULT ${
      typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? null)
    }`;

  let directive = "";
  let js: string | undefined;
  if (message.includes("CODEMODE-STATE-READ")) {
    const result = request.toolResults.find((entry) => entry.id === "read-parent-todo");
    return result === undefined
      ? { toolCalls: [{ name: "todo", id: "read-parent-todo", input: {} }] }
      : `CODEMODE-PARENT-STATE ${JSON.stringify(result.output)}`;
  } else if (message.includes("CODEMODE-STATE-START")) {
    directive = "CODEMODE-STATE";
    js = [
      'await tools.todo({ todos: [{ content: "CODEMODE-PERSISTED-TODO", priority: "high", status: "pending" }] });',
      'await tools.bash({ command: "printf original > /tmp/code-mode-state.txt" });',
      'await tools.read_file({ filePath: "/tmp/code-mode-state.txt" });',
      'await tools.write_file({ filePath: "/tmp/code-mode-state.txt", content: "CODEMODE-PERSISTED-FILE" });',
      'return { todo: await tools.todo({}), file: await tools.read_file({ filePath: "/tmp/code-mode-state.txt" }) };',
    ].join("\n");
  } else if (message.includes("CODEMODE-VISIBILITY-CHILD")) {
    return request.tools.some((tool) => tool.name === "code_mode" || tool.name === "Workflow")
      ? "CHILD_WRAPPER_VISIBLE"
      : "CHILD_WRAPPER_ABSENT";
  } else if (message.includes("CODEMODE-VISIBILITY-START")) {
    directive = "CODEMODE-VISIBILITY";
    js = 'return await tools.agent({ message: "CODEMODE-VISIBILITY-CHILD" });';
  } else if (message.includes("CODEMODE-CONTINUE-START")) {
    directive = "CODEMODE-CONTINUE";
    js = 'return await tools.marker({ message: "first" });';
  } else if (message.includes("CODEMODE-RESUME-START")) {
    directive = "CODEMODE-RESUME";
    const listing = request.messages.map((entry) => entry.text).join("\n");
    const agentId = /<agent id="([^"]+)" name="marker"(?: [^>]*)?>/u.exec(listing)?.[1];
    if (agentId === undefined) throw new Error("No marker agent id in the parent announcement.");
    js = `const agentId = ${JSON.stringify(agentId)}; const results = []; for (const message of ["second", "third"]) { try { results.push(await tools.marker({ agentId, message })); } catch (error) { results.push(String(error)); } } return results;`;
  } else if (message.includes("CODEMODE-ECHO-START")) {
    directive = "CODEMODE-ECHO";
    js = 'return await tools.echo({ value: "hello" });';
  } else if (message.includes("CODEMODE-SUSPENSION-START")) {
    directive = "CODEMODE-SUSPENSION";
    js = [
      "let result, cleanup;",
      "try {",
      '  result = await tools.echo({ value: "suspended" });',
      "} catch (error) {",
      "  for (let i = 0; i < 100000; i++) {}",
      "  throw error;",
      "} finally {",
      '  cleanup = await tools.echo({ value: "cleanup" });',
      "}",
      "return { result, cleanup };",
    ].join("\n");
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
      `const direct = ${JSON.stringify(direct)};`,
      "const complete = direct.every(name => catalog.some(tool => tool.name === name)) && catalog.filter(tool => tool.requiresDirectCall).every(tool => direct.includes(tool.name));",
      'const schemas = await tools.describe_tools({ names: ["background", "connection_search"] });',
      'const matches = await tools.search_tools({ query: "ECHO prefix nonexistentkeyword" });',
      'const keywords = matches.some(tool => tool.name === "echo");',
      'return { complete, keywords, schemas: schemas.every(tool => tool.requiresDirectCall && tool.inputSchema.type === "object") };',
    ].join("\n");
  } else if (message.includes("CODEMODE-CONNECTIONS-START")) {
    directive = "CODEMODE-CONNECTIONS";
    if (!request.toolResults.some((entry) => entry.id === "CODEMODE-CONNECTIONS-MISSING")) {
      return {
        toolCalls: [
          {
            id: "CODEMODE-CONNECTIONS-MISSING",
            name: "code_mode",
            input: {
              js: [
                'const matches = await tools.search_tools({ query: "getStatus" });',
                'if (matches.some(tool => tool.name === "catalog__getStatus")) throw new Error("Undiscovered connection tool was already loaded.");',
                'const [fallback] = await tools.describe_tools({ names: ["connection_search"] });',
                'if (!fallback.requiresDirectCall) throw new Error("Connection discovery must run directly.");',
                "return { missing: true };",
              ].join("\n"),
            },
          },
        ],
      };
    }
    if (!request.toolResults.some((entry) => entry.name === "connection_search")) {
      return {
        toolCalls: [
          { name: "connection_search", input: { connection: "catalog", keywords: "status" } },
        ],
      };
    }
    if (request.tools.some((tool) => tool.name === "catalog__getStatus")) {
      throw new Error("Code Mode exposed the discovered connection tool directly.");
    }
    // The inline spec tests discovery without making an external API request.
    js = [
      'const matches = await tools.search_tools({ query: "catalog status nonexistentkeyword" });',
      'const match = matches.find(tool => tool.name === "catalog__getStatus"); if (!match) throw new Error("Keyword search did not find the discovered tool.");',
      "const [discovered] = await tools.describe_tools({ names: [match.name] });",
      'if (discovered.inputSchema.type !== "object") throw new Error("Discovered tool schema is missing.");',
      'return { discovered: discovered.name, requiresDirectCall: discovered.requiresDirectCall, echo: await tools.echo({ value: "catalog-ready" }) };',
    ].join("\n");
  } else if (message.includes("CODEMODE-ASK-START")) {
    directive = "CODEMODE-ASK";
    js = [
      'const answer = await tools.ask_question({ prompt: "Ship the CODEMODE-ASK build?", options: [{ id: "ship", label: "Ship" }, { id: "hold", label: "Hold" }] });',
      'const echo = await tools.echo({ value: "after-ask:" + answer.optionId });',
      "return { answer, echo };",
    ].join("\n");
  } else if (message.includes("CODEMODE-APPROVAL-START")) {
    directive = "CODEMODE-APPROVAL";
    js = [
      "const first = await tools.gated({});",
      "const second = await tools.gated_once({});",
      "const third = await tools.gated_once({});",
      "return { first, second, third };",
    ].join("\n");
  } else if (message.includes("CODEMODE-DENY-START")) {
    directive = "CODEMODE-DENY";
    js = [
      "try {",
      "  await tools.gated({});",
      "  return { denied: false };",
      "} catch (error) {",
      '  return { denied: String(error).includes("CODE_MODE_APPROVAL_DENIED") };',
      "}",
    ].join("\n");
  } else if (message.includes("CODEMODE-WORKFLOW-START")) {
    directive = "CODEMODE-WORKFLOW";
    js = [
      'const planned = await tools.plan_deploy({ service: "CODEMODE-WF" });',
      "const echo = await tools.echo({ value: planned.plan });",
      "return { planned, echo };",
    ].join("\n");
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
    if (["shared", "discovered"].some((name) => names.includes(name))) {
      throw new Error("Code Mode exposed an eligible dynamic tool directly.");
    }
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
  experimental: { ...base.experimental, codeMode: true },
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
