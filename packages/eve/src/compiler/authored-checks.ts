import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledConnectionDefinition,
  type CompiledToolDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import {
  type AstNode,
  isFunctionNode,
  propertyName,
  readAuthoredAst,
  stringLiteral,
  unwrapExpression,
  visitAst,
} from "#compiler/authored-ast.js";
import {
  readWorkflowDirective,
  type DirectiveStatementNode,
} from "#internal/workflow-bundle/workflow-directive-ast.js";
import { closestName } from "#shared/closest-name.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import { findModelInputSchemaProblem } from "#tools/model-input-schema-problem.js";

export const COMPILE_APPROVAL_TOOL_NAME_UNKNOWN = "compile/approval-tool-name-unknown";

export const COMPILE_TOOL_INPUT_SCHEMA_INVALID = "compile/tool-input-schema-invalid";

export const COMPILE_WORKFLOW_AGENT_TARGET_UNKNOWN = "compile/workflow-agent-target-unknown";

interface AgentNodeScope {
  readonly agentNames: readonly string[];
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly connections: readonly CompiledConnectionDefinition[];
  readonly nodeId: string;
  readonly tools: readonly CompiledToolDefinition[];
}

interface ConnectionApprovalScan {
  readonly comparedToolNames: readonly string[];
  readonly operations?: { readonly list: "allow" | "block"; readonly names: readonly string[] };
}

export async function diagnoseAuthoredSources(
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
          message: `Tool "${tool.logicalPath}" has an invalid inputSchema: ${schemaProblem}`,
          severity: "error",
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
      const sources = [{ logicalPath: tool.logicalPath, nodeId: scope.nodeId, sourcePath }];
      for (const target of await readWorkflowAgentTargets(sourcePath)) {
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
    }
    for (const connection of scope.connections) {
      diagnostics.push(...(await diagnoseConnectionApproval(scope, connection)));
    }
  }
  return diagnostics;
}

async function diagnoseConnectionApproval(
  scope: AgentNodeScope,
  connection: CompiledConnectionDefinition,
): Promise<CompilerDiagnostic[]> {
  const binding = scope.bindings[connection.sourceId];
  if (binding?.owner.kind !== "application" || binding.backing.kind !== "filesystem") return [];
  const sourcePath = binding.backing.sourcePath;
  const scan = await scanConnectionApproval(sourcePath);
  const prefix = `${connection.connectionName}__`;
  const sources = [{ logicalPath: connection.logicalPath, nodeId: scope.nodeId, sourcePath }];
  const diagnose = (message: string): CompilerDiagnostic => ({
    code: COMPILE_APPROVAL_TOOL_NAME_UNKNOWN,
    message: `Connection "${connection.logicalPath}" approval compares toolName to ${message}`,
    severity: "error",
    sources,
  });
  return scan.comparedToolNames.flatMap((toolName) => {
    if (!toolName.startsWith(prefix)) {
      return [
        diagnose(
          `${JSON.stringify(toolName)}, but this connection names its tools "${prefix}<name>", so the comparison never matches and the approval never applies. Did you mean ${JSON.stringify(`${prefix}${toolName}`)}?`,
        ),
      ];
    }
    const operation = toolName.slice(prefix.length);
    const operations = scan.operations;
    if (operations === undefined) return [];
    const listed = operations.names.some(
      (name) => name === operation || name.replaceAll(/[^a-zA-Z0-9_-]/g, "_") === operation,
    );
    if (listed === (operations.list === "allow")) return [];
    return [
      diagnose(
        `${JSON.stringify(toolName)}, but operations.${operations.list} ${operations.list === "allow" ? "doesn't include" : "includes"} ${JSON.stringify(operation)}, so that tool never exists and the comparison never matches. ${operations.list === "allow" ? `Add ${JSON.stringify(operation)} to operations.allow` : `Remove ${JSON.stringify(operation)} from operations.block`} or remove the comparison.`,
      ),
    ];
  });
}

async function scanConnectionApproval(sourcePath: string): Promise<ConnectionApprovalScan> {
  const comparedToolNames = new Set<string>();
  let operations: ConnectionApprovalScan["operations"];
  visitAst(await readAuthoredAst(sourcePath, "approval"), (node) => {
    if (node.type !== "ObjectExpression") return;
    const properties = (node.properties as readonly AstNode[]).filter(
      (property) => property.type === "Property",
    );
    const approval = unwrapExpression(
      properties.find((property) => propertyName(property) === "approval")?.value,
    );
    if (!isFunctionNode(approval)) return;
    const matchesToolName = toolNameMatcher(approval!);
    if (matchesToolName === undefined) return;
    visitAst(approval!.body, (inner) => {
      for (const toolName of comparedLiterals(inner, matchesToolName)) {
        comparedToolNames.add(toolName);
      }
    });
    operations = readOperationsFilter(properties) ?? operations;
  });
  return { comparedToolNames: [...comparedToolNames], ...(operations && { operations }) };
}

function toolNameMatcher(approval: AstNode): ((node: unknown) => boolean) | undefined {
  const parameter = unwrapExpression((approval.params as readonly AstNode[] | undefined)?.[0]);
  if (parameter?.type === "Identifier") {
    return (node) => {
      const member = unwrapExpression(node);
      const object = unwrapExpression(member?.object);
      return (
        member?.type === "MemberExpression" &&
        object?.type === "Identifier" &&
        object.name === parameter.name &&
        (member.property as AstNode | undefined)?.name === "toolName"
      );
    };
  }
  if (parameter?.type !== "ObjectPattern") return undefined;
  const binding = (parameter.properties as readonly AstNode[])
    .filter((property) => property.type === "Property" && propertyName(property) === "toolName")
    .map((property) => {
      const value = unwrapExpression(property.value);
      return value?.type === "AssignmentPattern" ? unwrapExpression(value.left) : value;
    })
    .find((value) => value?.type === "Identifier");
  if (binding === undefined) return undefined;
  return (node) => {
    const value = unwrapExpression(node);
    return value?.type === "Identifier" && value.name === binding.name;
  };
}

function comparedLiterals(node: AstNode, matchesToolName: (node: unknown) => boolean): string[] {
  if (
    node.type === "BinaryExpression" &&
    ["===", "!==", "==", "!="].includes(node.operator as string)
  ) {
    const literal = matchesToolName(node.left)
      ? stringLiteral(node.right)
      : matchesToolName(node.right)
        ? stringLiteral(node.left)
        : undefined;
    return literal === undefined ? [] : [literal];
  }
  if (node.type === "SwitchStatement" && matchesToolName(node.discriminant)) {
    return (node.cases as readonly AstNode[]).flatMap((switchCase) => {
      const literal = stringLiteral(switchCase.test);
      return literal === undefined ? [] : [literal];
    });
  }
  return [];
}

function readOperationsFilter(
  properties: readonly AstNode[],
): ConnectionApprovalScan["operations"] | undefined {
  const operations = unwrapExpression(
    properties.find((property) => propertyName(property) === "operations")?.value,
  );
  if (operations?.type !== "ObjectExpression") return undefined;
  for (const property of operations.properties as readonly AstNode[]) {
    const list = propertyName(property);
    const elements = unwrapExpression(property.value);
    if ((list !== "allow" && list !== "block") || elements?.type !== "ArrayExpression") continue;
    const names = (elements.elements as readonly unknown[]).map(stringLiteral);
    if (names.some((name) => name === undefined)) return undefined;
    return { list, names: names as string[] };
  }
  return undefined;
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
      connections: manifest.connections,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      tools: manifest.tools,
    },
    ...manifest.subagents.map((subagent) => ({
      agentNames: [
        ...childNames(subagent.nodeId),
        ...subagent.agent.remoteAgents.map((agent) => agent.name),
      ],
      bindings: subagent.agent.bindings,
      connections: subagent.agent.connections,
      nodeId: subagent.nodeId,
      tools: subagent.agent.tools,
    })),
  ];
}

async function readWorkflowAgentTargets(sourcePath: string): Promise<string[]> {
  const targets = new Set<string>();
  visitAst(await readAuthoredAst(sourcePath, "use workflow"), (node) => {
    const contextName = workflowContextName(node);
    if (contextName === undefined) return;
    visitAst(node.body, (inner) => {
      const target = literalAgentTarget(inner, contextName);
      if (target !== undefined) targets.add(target);
    });
  });
  return [...targets];
}

function workflowContextName(node: AstNode): string | undefined {
  if (!isFunctionNode(node)) return undefined;
  const body = node.body as { readonly body?: readonly DirectiveStatementNode[] } | undefined;
  if (readWorkflowDirective(body?.body?.[0]) !== "use workflow") return undefined;
  const context = unwrapExpression((node.params as readonly AstNode[] | undefined)?.[1]);
  return context?.type === "Identifier" ? (context.name as string) : undefined;
}

function literalAgentTarget(node: AstNode, contextName: string): string | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = unwrapExpression(node.callee);
  const object = unwrapExpression(callee?.object);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed === true ||
    object?.type !== "Identifier" ||
    object.name !== contextName ||
    (callee.property as AstNode | undefined)?.name !== "agent"
  ) {
    return undefined;
  }
  return stringLiteral((node.arguments as readonly unknown[] | undefined)?.[0]);
}
