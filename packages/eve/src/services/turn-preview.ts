import { randomUUID } from "node:crypto";

import type { ModelMessage } from "ai";

import { LOCAL_DEV_SESSION_AUTH_CONTEXT } from "#channel/auth/definitions.js";
import { HTTP_ADAPTER } from "#channel/http.js";
import { SCHEDULE_ADAPTER, SCHEDULE_APP_AUTH } from "#channel/schedule.js";
import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import { connectionProvider, ConnectionRegistryKey } from "#context/providers/connection.js";
import { sessionProvider } from "#context/providers/session.js";
import { renderSystem } from "#definitions/definition.js";
import { evaluateStepValues, stepDraft, stepMessages, type StepSource } from "#definitions/step.js";
import { buildStepCatalog } from "#execution/catalog/step-catalog.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { compiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedDefinition, ResolvedDynamicDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

export interface TurnPreviewTool {
  readonly name: string;
  readonly source: string;
  readonly deferred: boolean;
}

export interface TurnPreviewHiddenTool {
  readonly name: string;
  readonly source: string;
  readonly reason: string;
}

export interface TurnPreview {
  readonly auth: SessionAuthContext | null;
  readonly channel: { readonly name: string | null; readonly kind: string };
  readonly tools: readonly TurnPreviewTool[];
  readonly hiddenTools: readonly TurnPreviewHiddenTool[];
  readonly instructions: {
    readonly system: readonly string[];
    readonly context: readonly string[];
  };
  readonly connections: readonly { readonly name: string; readonly protocol: string }[];
}

type DynamicOutcome = { readonly returned: unknown } | { readonly error: unknown };

export async function previewTurn(input: {
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly run: RunInput;
}): Promise<TurnPreview> {
  const outcomes = new Map<string, DynamicOutcome>();
  const bundle: CompiledRuntimeAgentBundle = {
    ...input.bundle,
    resolvedAgent: {
      ...input.bundle.resolvedAgent,
      definitions: input.bundle.resolvedAgent.definitions.map((definition) =>
        recordDynamicTool(definition, outcomes),
      ),
    },
  };
  const ctx = buildRunContext({ agent: await compiledSessionAgent(bundle), run: input.run });
  const sessionId = `eve-preview-${randomUUID()}`;
  ctx.set(SessionIdKey, sessionId);
  enterSessionProjection(ctx, undefined);
  const unstarted = { state: undefined };
  ctx.set(SessionKey, sessionProvider.create(ctx, unstarted).value);
  const registry = await connectionProvider.create(ctx, unstarted as never);
  if (registry !== undefined) ctx.set(ConnectionRegistryKey, registry.value);

  const staticTools = createNodeHarnessTools({ node: bundle.graph.root });
  const staticSource = (name: string): string =>
    staticTools.get(name)?.frameworkTool === true
      ? "eve"
      : (findRegisteredRuntimeTool(bundle.toolRegistry, name)?.definition.logicalPath ?? "eve");
  const step: StepSource = {
    config: { tools: staticTools },
    ctx,
    finalReplyOnly: input.run.capabilities?.requestInput !== true,
    session: { rootSessionId: undefined },
  };
  try {
    return await contextStorage.run(ctx, async () => {
      await evaluateStepValues(step, { conversation: conversationOf(input.run) });
      const call = { currentInput: new Set<never>(), historyState: {}, record: [] };
      const draft = await stepDraft(step, call);
      const table = await draft.tools();
      const catalog = buildStepCatalog({ ctx, endsTurn: false, session: step.session, table });
      const { record } = await stepMessages(draft, { call, project: (messages) => [...messages] });
      const system = renderSystem(await draft.system());

      const sourceOf = (name: string): string => {
        const source = table.entries.get(name)?.source;
        if (source === "eve.tools") return staticSource(name);
        return (
          dynamicToolFiles(bundle).find((file) => toolDefinitionId(file) === source)?.logicalPath ??
          "eve"
        );
      };
      const tools = [...catalog.entries.keys()].map((name) => ({
        deferred: catalog.deferred.has(name),
        name,
        source: sourceOf(name),
      }));
      return {
        auth: input.run.auth,
        channel: {
          kind: input.run.adapter.kind,
          name: input.run.channelName ?? null,
        },
        connections: catalog.connections.map((connection) => ({
          name: connection.connectionName,
          protocol: connection.protocol,
        })),
        hiddenTools: hiddenTools({
          auth: input.run.auth,
          bundle,
          offered: new Set(catalog.entries.keys()),
          outcomes,
          staticTools: [...staticTools.keys()].map((name) => ({
            name,
            source: staticSource(name),
          })),
        }),
        instructions: {
          context: record.flatMap(({ content }) => (typeof content === "string" ? [content] : [])),
          system: typeof system === "string" ? [system] : [...system],
        },
        tools,
      };
    });
  } finally {
    await registry?.value.dispose();
  }
}

function conversationOf(run: RunInput): ModelMessage[] {
  const message = run.input.message;
  return typeof message === "string" ? [{ content: message, role: "user" }] : [];
}

function dynamicToolFiles(bundle: CompiledRuntimeAgentBundle) {
  return bundle.resolvedAgent.definitions.filter(
    (definition): definition is ResolvedDynamicDefinition<"tool"> => definition.kind === "tool",
  );
}

function toolDefinitionId(file: ResolvedDynamicDefinition<"tool">): string {
  return `tool:${file.extensionNamespace ?? ""}:${file.slug}`;
}

function recordDynamicTool(
  definition: ResolvedDefinition,
  outcomes: Map<string, DynamicOutcome>,
): ResolvedDefinition {
  if (definition.kind !== "tool") return definition;
  const evaluate = definition.evaluate as (ctx: unknown) => unknown;
  return {
    ...definition,
    evaluate: (async (ctx: unknown) => {
      try {
        const returned = await evaluate(ctx);
        outcomes.set(toolDefinitionId(definition), { returned });
        return returned;
      } catch (error) {
        outcomes.set(toolDefinitionId(definition), { error });
        return null;
      }
    }) as never,
  };
}

function hiddenTools(input: {
  readonly auth: SessionAuthContext | null;
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly offered: ReadonlySet<string>;
  readonly outcomes: ReadonlyMap<string, DynamicOutcome>;
  readonly staticTools: readonly { readonly name: string; readonly source: string }[];
}): TurnPreviewHiddenTool[] {
  const caller =
    input.auth === null ? "an anonymous caller" : `principalType ${input.auth.principalType}`;
  const hidden: TurnPreviewHiddenTool[] = input.staticTools
    .filter(({ name }) => !input.offered.has(name))
    .map(({ name, source }) => ({
      name,
      reason: "eve doesn't offer this tool to this session",
      source,
    }));
  for (const file of dynamicToolFiles(input.bundle)) {
    const outcome = input.outcomes.get(toolDefinitionId(file));
    const name =
      file.extensionNamespace === undefined
        ? file.slug
        : `${file.extensionNamespace}__${file.slug}`;
    if (outcome === undefined) {
      hidden.push({ name, reason: "defineDynamic wasn't evaluated", source: file.logicalPath });
    } else if ("error" in outcome) {
      hidden.push({
        name,
        reason: `defineDynamic threw for ${caller}, which fails the turn: ${toErrorMessage(outcome.error)}`,
        source: file.logicalPath,
      });
    } else if (offersNothing(outcome.returned)) {
      hidden.push({
        name,
        reason: `defineDynamic returned ${describeEmpty(outcome.returned)} for ${caller}`,
        source: file.logicalPath,
      });
    }
  }
  return hidden;
}

function offersNothing(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "object" && Object.keys(value).length === 0)
  );
}

function describeEmpty(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  return Array.isArray(value) ? "an empty list" : "an empty map";
}

export type PreviewPrincipal =
  | { readonly kind: "anonymous" }
  | { readonly kind: "local-dev" }
  | { readonly kind: "schedule" }
  | {
      readonly kind: "user";
      readonly authenticator?: string;
      readonly groups: readonly string[];
      readonly id?: string;
    };

const PRINCIPAL_SYNTAX =
  "local-dev | schedule | anonymous | user[:groups=a,b][:authenticator=name][:id=name]";

export function parsePreviewPrincipal(value: string): PreviewPrincipal {
  const [kind, ...fields] = value.trim().split(/:(?=(?:groups|authenticator|id)=)/);
  if ((kind === "schedule" || kind === "anonymous" || kind === "local-dev") && fields.length === 0)
    return { kind };
  if (kind !== "user") {
    throw new Error(`Unknown principal "${value}". Use ${PRINCIPAL_SYNTAX}.`);
  }
  let principal: Extract<PreviewPrincipal, { kind: "user" }> = { groups: [], kind: "user" };
  for (const field of fields) {
    const separator = field.indexOf("=");
    const key = field.slice(0, separator);
    const fieldValue = field.slice(separator + 1);
    if (separator <= 0 || fieldValue === "") {
      throw new Error(`Invalid principal field "${field}" in "${value}". Use ${PRINCIPAL_SYNTAX}.`);
    }
    if (key === "groups") {
      principal = { ...principal, groups: fieldValue.split(",").filter((group) => group !== "") };
    } else if (key === "authenticator" || key === "id") {
      principal = { ...principal, [key]: fieldValue };
    } else {
      throw new Error(`Unknown principal field "${key}" in "${value}". Use ${PRINCIPAL_SYNTAX}.`);
    }
  }
  return principal;
}

export function principalAuth(principal: PreviewPrincipal): SessionAuthContext | null {
  switch (principal.kind) {
    case "anonymous":
      return null;
    case "local-dev":
      return LOCAL_DEV_SESSION_AUTH_CONTEXT;
    case "schedule":
      return SCHEDULE_APP_AUTH;
    case "user":
      return {
        attributes: principal.groups.length === 0 ? {} : { groups: principal.groups },
        authenticator: principal.authenticator ?? "eve-preview",
        principalId: principal.id ?? "eve-preview:user",
        principalType: "user",
      };
  }
}

export function previewRunFor(principal: PreviewPrincipal, message?: string): RunInput {
  const input = message === undefined ? {} : { message };
  if (principal.kind === "schedule") {
    return {
      adapter: SCHEDULE_ADAPTER,
      auth: SCHEDULE_APP_AUTH,
      capabilities: { requestInput: false },
      input,
    };
  }
  return {
    adapter: HTTP_ADAPTER,
    auth: principalAuth(principal),
    capabilities: { requestInput: true },
    input,
  };
}
