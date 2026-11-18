import { readFile } from "node:fs/promises";

import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledToolDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import { parseWorkflowSourceAst } from "#internal/workflow-bundle/workflow-source-ast.js";
import {
  readWorkflowDirective,
  type DirectiveStatementNode,
} from "#internal/workflow-bundle/workflow-directive-ast.js";
import { closestName } from "#shared/closest-name.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import { findModelInputSchemaProblem } from "#tools/model-input-schema-problem.js";

export const COMPILE_TOOL_INPUT_SCHEMA_INVALID = "compile/tool-input-schema-invalid";

export const COMPILE_WORKFLOW_AGENT_TARGET_UNKNOWN = "compile/workflow-agent-target-unknown";

export const COMPILE_WORKFLOW_STEP_API_IN_BODY = "compile/workflow-step-api-in-body";

const STEP_ONLY_CONTEXT_MEMBERS = new Set(["getSandbox", "getToken", "requireAuth", "to"]);

interface WorkflowBodyScan {
  readonly agentTargets: readonly string[];
  readonly stepOnlyCalls: readonly string[];
}

interface AgentNodeScope {
  readonly agentNames: readonly string[];
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly nodeId: string;
  readonly tools: readonly CompiledToolDefinition[];
}

interface AstNode {
  readonly [key: string]: unknown;
  readonly type?: unknown;
}

export async function diagnoseAuthoredTools(
  manifest: CompiledAgentManifest,
): Promise<CompilerDiagnostic[]> {
  const diagnostics: CompilerDiagnostic[] = [];
  for (const scope of agentNodeScopes(manifest)) {
    for (const tool of scope.tools) {
      const schemaProblem =
        tool.modelInputSchema === undefined
          ? undefined
          : findModelInputSchemaProblem(tool.modelInputSchema);
      if (schemaProblem !== undefined) {
        const binding = scope.bindings[tool.sourceId];
        diagnostics.push({
          code: COMPILE_TOOL_INPUT_SCHEMA_INVALID,
          message: `Tool "${tool.logicalPath}" has an invalid inputSchema: ${schemaProblem.message}`,
          severity: schemaProblem.severity,
          sources: [
            {
              logicalPath: tool.logicalPath,
              nodeId: scope.nodeId,
              ...(binding?.backing.kind === "filesystem" && {
                sourcePath: binding.backing.sourcePath,
              }),
            },
          ],
        });
      }
      if (tool.behavior?.handling?.kind !== "workflow-tool") continue;
      const binding = scope.bindings[tool.sourceId];
      if (binding?.owner.kind !== "application" || binding.backing.kind !== "filesystem") continue;
      const sourcePath = binding.backing.sourcePath;
      const scan = await scanWorkflowBodies(sourcePath);
      const sources = [{ logicalPath: tool.logicalPath, nodeId: scope.nodeId, sourcePath }];
      for (const target of scan.agentTargets) {
        if (scope.agentNames.includes(target)) continue;
        const match = closestName(target, scope.agentNames);
        diagnostics.push({
          code: COMPILE_WORKFLOW_AGENT_TARGET_UNKNOWN,
          message:
            `Tool "${tool.logicalPath}" calls ctx.agent(${JSON.stringify(target)}), but no agent by that name is available to it.` +
            (match === undefined ? "" : ` Did you mean ${JSON.stringify(match)}?`) +
            ` Available: ${scope.agentNames.map((name) => JSON.stringify(name)).join(", ")}.`,
          severity: "error",
          sources,
        });
      }
      for (const member of scan.stepOnlyCalls) {
        diagnostics.push({
          code: COMPILE_WORKFLOW_STEP_API_IN_BODY,
          message: `Tool "${tool.logicalPath}" calls ctx.${member}() in its "use workflow" body, where it always throws. Pass ctx to a "use step" helper and call ctx.${member}() there.`,
          severity: "error",
          sources,
        });
      }
    }
  }
  return diagnostics;
}

function agentNodeScopes(manifest: CompiledAgentManifest): AgentNodeScope[] {
  const childNames = (nodeId: string) =>
    manifest.subagents
      .filter((subagent) => subagent.parentNodeId === nodeId)
      .map((subagent) => subagent.name);
  return [
    {
      agentNames: [
        ...childNames(ROOT_COMPILED_AGENT_NODE_ID),
        ...manifest.remoteAgents.map((agent) => agent.name),
        AGENT_TOOL_NAME,
      ],
      bindings: manifest.bindings,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      tools: manifest.tools,
    },
    ...manifest.subagents.map((subagent) => ({
      agentNames: [
        ...childNames(subagent.nodeId),
        ...subagent.agent.remoteAgents.map((agent) => agent.name),
      ],
      bindings: subagent.agent.bindings,
      nodeId: subagent.nodeId,
      tools: subagent.agent.tools,
    })),
  ];
}

async function scanWorkflowBodies(sourcePath: string): Promise<WorkflowBodyScan> {
  const source = await readFile(sourcePath, "utf8");
  const agentTargets = new Set<string>();
  const stepOnlyCalls = new Set<string>();
  if (!source.includes("use workflow")) return { agentTargets: [], stepOnlyCalls: [] };
  visit((await parseWorkflowSourceAst(sourcePath, source)) as AstNode, (node) => {
    const contextName = workflowContextName(node);
    if (contextName === undefined) return;
    visit(node.body as AstNode, (inner) => {
      const call = contextCall(inner, contextName);
      if (call === undefined) return;
      if (call.member === "agent" && call.literal !== undefined) agentTargets.add(call.literal);
      if (STEP_ONLY_CONTEXT_MEMBERS.has(call.member)) stepOnlyCalls.add(call.member);
    });
  });
  return { agentTargets: [...agentTargets], stepOnlyCalls: [...stepOnlyCalls] };
}

function workflowContextName(node: AstNode): string | undefined {
  if (
    node.type !== "FunctionDeclaration" &&
    node.type !== "FunctionExpression" &&
    node.type !== "ArrowFunctionExpression"
  ) {
    return undefined;
  }
  const body = node.body as { readonly body?: readonly DirectiveStatementNode[] } | undefined;
  if (readWorkflowDirective(body?.body?.[0]) !== "use workflow") return undefined;
  const context = (node.params as readonly AstNode[] | undefined)?.[1];
  return context?.type === "Identifier" ? (context.name as string) : undefined;
}

function contextCall(
  node: AstNode,
  contextName: string,
): { readonly literal?: string; readonly member: string } | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee as AstNode | undefined;
  const object = unwrapExpression(callee?.object as AstNode | undefined);
  const property = callee?.property as AstNode | undefined;
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed === true ||
    object?.type !== "Identifier" ||
    object.name !== contextName ||
    typeof property?.name !== "string"
  ) {
    return undefined;
  }
  const [argument] = (node.arguments as readonly AstNode[] | undefined) ?? [];
  const quasis = argument?.quasis as readonly { value: { cooked?: string } }[] | undefined;
  const literal =
    argument?.type === "Literal" && typeof argument.value === "string"
      ? argument.value
      : argument?.type === "TemplateLiteral" && quasis?.length === 1
        ? quasis[0]!.value.cooked
        : undefined;
  return { member: property.name, ...(literal !== undefined && { literal }) };
}

const EXPRESSION_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function unwrapExpression(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (current !== undefined && EXPRESSION_WRAPPERS.has(current.type as string)) {
    current = current.expression as AstNode | undefined;
  }
  return current;
}

function visit(node: AstNode | undefined, onNode: (node: AstNode) => void): void {
  if (node === undefined || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child as AstNode, onNode);
    return;
  }
  if (typeof node.type === "string") onNode(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent" && typeof value === "object") visit(value as AstNode, onNode);
  }
}
