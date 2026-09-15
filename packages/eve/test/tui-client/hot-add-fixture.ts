import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = dirname(fileURLToPath(import.meta.url));
export const hotAddAppRoot = resolve(testRoot, "../../../../apps/fixtures/agent-tui-hot-add");
const subagentRoot = resolve(hotAddAppRoot, "agent/subagents/self-modification");

export async function removeApprovalSubagent(): Promise<void> {
  await rm(subagentRoot, { force: true, recursive: true });
}

export async function installApprovalSubagent(): Promise<void> {
  await mkdir(resolve(subagentRoot, "tools"), { recursive: true });
  await Promise.all([
    writeFile(
      resolve(subagentRoot, "agent.ts"),
      `import { defineAgent } from "eve";\nimport { mockModel, type MockModelRequest } from "eve/evals";\n\nfunction respond(request: MockModelRequest) {\n  return request.toolResults.some((result) => result.name === "selfmod__registry_add")\n    ? "installed"\n    : { toolCalls: [{ input: { address: "connection/linear" }, name: "selfmod__registry_add" }] };\n}\n\nexport default defineAgent({\n  description: "Install capabilities requested by the parent.",\n  model: mockModel(respond),\n  modelContextWindowTokens: 1_000_000,\n});\n`,
      "utf8",
    ),
    writeFile(
      resolve(subagentRoot, "instructions.md"),
      "Call selfmod__registry_add exactly once.\n",
      "utf8",
    ),
    writeFile(
      resolve(subagentRoot, "tools/selfmod__registry_add.ts"),
      `import { defineTool } from "eve/tools";\nimport { once } from "eve/tools/approval";\nimport { z } from "zod";\n\nexport default defineTool({\n  approval: once(),\n  description: "Approval-gated registry installation stand-in.",\n  inputSchema: z.object({ address: z.string() }),\n  execute: async ({ address }) => ({ address, status: "installed" }),\n});\n`,
      "utf8",
    ),
  ]);
}
