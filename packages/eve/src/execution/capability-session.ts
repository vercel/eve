/**
 * Runs one compiled agent tool outside the model loop, inside the same kind of
 * eve context a harness step builds, for a synthetic *capability session*.
 *
 * A capability session has no workflow, history, or model. Its only
 * server-side state is the sandbox, keyed by the capability session id. The
 * id is deterministic (`sha256(principalKey + "\n" + sessionKey)`), and every
 * shipped sandbox provider derives its sandbox identity from the session id,
 * so a fresh function instance that starts with no cached state reattaches to
 * the same sandbox. The in-process cache only avoids repeated resume work.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JSONValue } from "ai";

import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalConfiguration,
} from "#approval/definition.js";
import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SandboxKey,
  SessionIdKey,
  SessionKey,
  type Session,
} from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { buildApprovalResponseAuth, createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  AuthorizationCallbackUrlKey,
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
  type AuthorizationChallenge,
  type AuthorizationResult,
  type AuthorizationSignal,
} from "#harness/authorization.js";
import {
  normalizeToolJsonOutput,
  normalizeToolModelOutput,
  type ToolModelOutputValue,
} from "#harness/tool-model-output.js";
import { createLogger, logError } from "#internal/logging.js";
import { getRuntimeCompiledArtifactsAppRoot } from "#runtime/compiled-artifacts-source.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import type { ResolvedSkillDefinition, ResolvedToolDefinition } from "#runtime/types.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import { createUlid } from "#shared/ulid.js";

const log = createLogger("execution.capability-session");

/** Everything the capabilities channel needs from one compiled agent. */
export interface CapabilityRuntime {
  readonly agentName: string;
  readonly description?: string;
  /** Tools exposed to remote callers, in advertised order. */
  readonly tools: readonly ResolvedToolDefinition[];
  readonly skills: readonly ResolvedSkillDefinition[];
  readonly hasSandbox: boolean;
  /**
   * Reads a supporting skill file from compiled artifacts on disk. Returns
   * `undefined` when unavailable (bundled deployments), and callers fall back
   * to the sandbox copy.
   */
  readSkillFile?(skillName: string, path: string): Promise<Uint8Array | undefined>;
  /** Seeds `BundleKey` for tools that read the compiled graph. Absent in tests. */
  readonly bundle?: CompiledRuntimeAgentBundle;
  openSandbox(sessionId: string): Promise<SandboxAccess>;
}

/** Builds the capability view of the root agent in a compiled bundle. */
export function createCapabilityRuntime(bundle: CompiledRuntimeAgentBundle): CapabilityRuntime {
  const node = bundle.graph.root;
  const registry = node.sandboxRegistry;
  return {
    agentName: bundle.resolvedAgent.config?.name ?? "eve",
    bundle,
    description: bundle.resolvedAgent.config?.description,
    hasSandbox: registry.sandbox !== null,
    async openSandbox(sessionId) {
      return await ensureSandboxAccess({
        compiledArtifactsSource: bundle.compiledArtifactsSource,
        nodeId: node.nodeId,
        ownsSandbox: true,
        registry,
        sessionId,
        state: null,
      });
    },
    async readSkillFile(skillName, path) {
      const appRoot = getRuntimeCompiledArtifactsAppRoot(bundle.compiledArtifactsSource);
      if (appRoot === undefined) return undefined;
      const file = join(
        appRoot,
        ".eve",
        "compile",
        "workspace-resources",
        node.nodeId,
        "skills",
        skillName,
        ...path.split("/"),
      );
      return await readFile(file).catch(() => undefined);
    },
    skills: bundle.resolvedAgent.skills,
    tools: listExposedTools(bundle),
  };
}

/**
 * Authored and extension tools that run to completion in one call. Framework
 * tools (load_skill, bash, subagents, task control), workflow tools, and
 * background tools need the model loop or durable runtime, so they stay out.
 */
function listExposedTools(bundle: CompiledRuntimeAgentBundle): ResolvedToolDefinition[] {
  const tools: ResolvedToolDefinition[] = [];
  for (const prepared of bundle.turnAgent.tools) {
    if (prepared.task !== undefined) continue;
    const definition = findRegisteredRuntimeTool(bundle.toolRegistry, prepared.name)?.definition;
    if (
      definition === undefined ||
      definition.owner.kind === "framework" ||
      definition.execution === "background" ||
      definition.execute === undefined ||
      definition.behavior?.handling !== undefined
    ) {
      continue;
    }
    tools.push(definition);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

export interface CapabilitySessionScope {
  readonly id: string;
  /** Requests without a caller session key get a throwaway scope. */
  readonly ephemeral: boolean;
}

export const MAX_CAPABILITY_SESSION_KEY_LENGTH = 512;

/** Scopes a caller-supplied session key to the authenticated principal. */
export function resolveCapabilitySessionScope(
  auth: SessionAuthContext | null,
  sessionKey: string | undefined,
): CapabilitySessionScope {
  const principal = JSON.stringify(
    auth === null
      ? ["anonymous"]
      : [auth.authenticator, auth.issuer ?? null, auth.principalType, auth.principalId],
  );
  const ephemeral = sessionKey === undefined;
  const key = sessionKey ?? `ephemeral:${randomUUID()}`;
  return {
    ephemeral,
    id: createHash("sha256").update(`${principal}\n${key}`).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Sandbox cache
// ---------------------------------------------------------------------------

interface CachedSandbox {
  readonly access: SandboxAccess;
  lastUsedAt: number;
  ready: boolean;
  warming?: Promise<void>;
}

const SANDBOX_CACHE_MAX_ENTRIES = 256;
const SANDBOX_CACHE_IDLE_MS = 30 * 60_000;
const sandboxCache = new Map<string, CachedSandbox>();

function sandboxCacheKey(runtime: CapabilityRuntime, sessionId: string): string {
  return `${runtime.agentName}\n${sessionId}`;
}

function evictIdleSandboxes(now: number): void {
  for (const [key, entry] of sandboxCache) {
    if (now - entry.lastUsedAt > SANDBOX_CACHE_IDLE_MS) sandboxCache.delete(key);
  }
  // Map iteration is insertion order and every hit re-inserts, so the first
  // entries are the least recently used. Eviction drops only the in-process
  // handle; the provider sandbox itself is left to its own idle timeout.
  while (sandboxCache.size > SANDBOX_CACHE_MAX_ENTRIES) {
    const oldest = sandboxCache.keys().next().value;
    if (oldest === undefined) break;
    sandboxCache.delete(oldest);
  }
}

async function acquireSandbox(
  runtime: CapabilityRuntime,
  scope: CapabilitySessionScope,
): Promise<CachedSandbox | undefined> {
  if (!runtime.hasSandbox) return undefined;
  if (scope.ephemeral) {
    return { access: await runtime.openSandbox(scope.id), lastUsedAt: Date.now(), ready: false };
  }
  const key = sandboxCacheKey(runtime, scope.id);
  const now = Date.now();
  let entry = sandboxCache.get(key);
  if (entry !== undefined) {
    sandboxCache.delete(key);
  } else {
    entry = { access: await runtime.openSandbox(scope.id), lastUsedAt: now, ready: false };
  }
  entry.lastUsedAt = now;
  sandboxCache.set(key, entry);
  evictIdleSandboxes(now);
  return entry;
}

function forgetSandbox(runtime: CapabilityRuntime, sessionId: string, entry: CachedSandbox): void {
  const key = sandboxCacheKey(runtime, sessionId);
  if (sandboxCache.get(key) === entry) sandboxCache.delete(key);
}

export type CapabilitySandboxStatus = "none" | "warming" | "ready";

/** Reports what `server/discover` knows about a session's sandbox. */
export function readCapabilitySandboxStatus(
  runtime: CapabilityRuntime,
  scope: CapabilitySessionScope,
): CapabilitySandboxStatus {
  if (!runtime.hasSandbox || scope.ephemeral) return "none";
  return sandboxCache.get(sandboxCacheKey(runtime, scope.id))?.ready === true ? "ready" : "warming";
}

/**
 * Starts provisioning a session's sandbox. Resolves once the sandbox is open
 * (or failed); callers hand the promise to `waitUntil`.
 */
export async function warmCapabilitySandbox(input: {
  readonly auth: SessionAuthContext | null;
  readonly runtime: CapabilityRuntime;
  readonly scope: CapabilitySessionScope;
}): Promise<void> {
  if (!input.runtime.hasSandbox || input.scope.ephemeral) return;
  const entry = await acquireSandbox(input.runtime, input.scope);
  if (entry === undefined || entry.ready) return;
  entry.warming ??= runInCapabilityContext(
    { auth: input.auth, runtime: input.runtime, sandbox: entry.access, sessionId: input.scope.id },
    async () => {
      await entry.access.get();
    },
  )
    .then(() => {
      entry.ready = true;
    })
    .catch((error: unknown) => {
      entry.warming = undefined;
      forgetSandbox(input.runtime, input.scope.id, entry);
      logError(log, "capability sandbox prewarm failed", error);
    });
  await entry.warming;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** One callback result handed back to `completeAuthorization` on retry. */
export type CapabilityAuthorizationResult = AuthorizationResult & { readonly name: string };

interface CapabilityContextInput {
  readonly auth: SessionAuthContext | null;
  readonly authorizationResults?: readonly CapabilityAuthorizationResult[];
  readonly callbackUrl?: (name: string, attemptId: string) => string;
  readonly runtime: CapabilityRuntime;
  readonly sandbox?: SandboxAccess;
  readonly sessionId: string;
}

/** Runs `callback` with the ALS keys a harness step would provide to a tool. */
async function runInCapabilityContext<T>(
  input: CapabilityContextInput,
  callback: () => Promise<T>,
): Promise<T> {
  const ctx = new ContextContainer();
  if (input.runtime.bundle !== undefined) ctx.set(BundleKey, input.runtime.bundle);
  ctx.set(AuthKey, input.auth);
  ctx.set(InitiatorAuthKey, input.auth);
  ctx.set(SessionIdKey, input.sessionId);
  const session: Session = {
    auth: { current: input.auth, initiator: input.auth },
    sessionId: input.sessionId,
    turn: { id: `capability_${createUlid()}`, sequence: 0 },
  };
  ctx.setVirtualContext(SessionKey, session);
  ctx.setVirtualContext(SandboxKey, input.sandbox ?? unavailableSandbox);
  if (input.callbackUrl !== undefined) {
    ctx.setVirtualContext(AuthorizationCallbackUrlKey, input.callbackUrl);
  }
  if (input.authorizationResults !== undefined && input.authorizationResults.length > 0) {
    ctx.setVirtualContext(PendingAuthorizationResultKey, input.authorizationResults);
  }
  return await contextStorage.run(ctx, callback);
}

const unavailableSandbox: SandboxAccess = {
  async captureState() {
    return { session: null };
  },
  async get() {
    return null;
  },
  async stop() {},
};

/**
 * Runs `callback` inside a capability session context with the session's
 * sandbox. Ephemeral sandboxes are deleted afterwards so they do not outlive
 * the request; `defer` receives that cleanup.
 */
export async function withCapabilitySession<T>(
  input: Omit<CapabilityContextInput, "sandbox" | "sessionId"> & {
    readonly defer: (task: Promise<unknown>) => void;
    readonly scope: CapabilitySessionScope;
  },
  callback: () => Promise<T>,
): Promise<T> {
  const entry = await acquireSandbox(input.runtime, input.scope);
  try {
    return await runInCapabilityContext(
      { ...input, sandbox: entry?.access, sessionId: input.scope.id },
      callback,
    );
  } finally {
    if (entry !== undefined && input.scope.ephemeral) {
      input.defer(deleteEphemeralSandbox(entry.access));
    }
  }
}

async function deleteEphemeralSandbox(access: SandboxAccess): Promise<void> {
  // Deleting an unopened sandbox would provision it first; captureState tells
  // us whether anything was started.
  const state = await access.captureState();
  if (state.session === null || access.delete === undefined) return;
  await access.delete().catch((error: unknown) => {
    logError(log, "capability ephemeral sandbox cleanup failed", error);
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type CapabilityApprovalDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "user-approval" }
  | { readonly kind: "denied"; readonly reason?: string };

/** Evaluates a tool's request-time approval policy. Must run in a capability session. */
export async function evaluateCapabilityApproval(input: {
  readonly abortSignal: AbortSignal;
  readonly args: Readonly<Record<string, unknown>>;
  readonly callId: string;
  readonly tool: ResolvedToolDefinition;
}): Promise<CapabilityApprovalDecision> {
  if (input.tool.approval === undefined) return { kind: "allowed" };
  const status = await resolveApprovalPolicy(input.tool.approval)({
    ...buildCallbackContext(),
    abortSignal: input.abortSignal,
    approvedTools: new Set(),
    callId: input.callId,
    toolInput: input.args,
    toolName: input.tool.name,
  });
  if (status === true || status === "user-approval") return { kind: "user-approval" };
  if (typeof status === "object" && status.type === "user-approval") {
    return { kind: "user-approval" };
  }
  if (status === "denied") return { kind: "denied" };
  if (typeof status === "object" && status.type === "denied") {
    return { kind: "denied", reason: status.reason };
  }
  return { kind: "allowed" };
}

/**
 * Applies the tool's response policy to an approval answered by the same
 * authenticated caller. Must run in a capability session.
 */
export async function authorizeCapabilityApprovalResponse(input: {
  readonly args: Readonly<Record<string, unknown>>;
  readonly auth: SessionAuthContext | null;
  readonly callId: string;
  readonly tool: ResolvedToolDefinition;
}): Promise<CapabilityApprovalDecision> {
  const response = readApprovalResponsePolicy(input.tool.approval);
  if (response === undefined) return { kind: "allowed" };
  if (input.auth === null) {
    return { kind: "denied", reason: "Approving this tool requires an authenticated caller." };
  }
  const session = buildCallbackContext().session;
  const decision = await response({
    auth: buildApprovalResponseAuth({ responder: input.auth, scope: input.tool.name }),
    request: {
      callId: input.callId,
      requestId: input.callId,
      toolInput: input.args,
      toolName: input.tool.name,
    },
    response: { decision: "approve" },
    responder: input.auth,
    session: { id: session.id, initiator: input.auth, turn: session.turn },
  });
  return decision.status === "allowed"
    ? { kind: "allowed" }
    : { kind: "denied", reason: decision.reason };
}

function readApprovalResponsePolicy(
  approval: Approval | undefined,
): ApprovalConfiguration["response"] | undefined {
  return typeof approval === "object" ? approval.response : undefined;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type CapabilityToolOutcome =
  | {
      readonly kind: "output";
      readonly modelOutput: ToolModelOutputValue;
      readonly output: unknown;
    }
  | { readonly kind: "authorization-required"; readonly signal: AuthorizationSignal }
  | { readonly kind: "invalid-input"; readonly message: string };

/**
 * Validates the input and runs the tool's executor with the token-aware
 * context eve gives tools in the model loop. Must run in a capability
 * session. Errors thrown by the tool propagate.
 */
export async function executeCapabilityTool(input: {
  readonly abortSignal: AbortSignal;
  readonly args: unknown;
  readonly callId: string;
  readonly tool: ResolvedToolDefinition;
}): Promise<CapabilityToolOutcome> {
  const { tool } = input;
  if (tool.execute === undefined) throw new Error(`Tool "${tool.name}" has no executor.`);

  let value = input.args;
  if (tool.inputSchema !== null) {
    const result = await tool.inputSchema["~standard"].validate(input.args);
    if (result.issues !== undefined) {
      return {
        kind: "invalid-input",
        message: result.issues
          .map((issue) => {
            const path = issue.path
              ?.map((segment) => (typeof segment === "object" ? segment.key : segment))
              .join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .join("; "),
      };
    }
    value = result.value;
  }

  const execute = createToolExecuteWithAuth({
    execute: tool.execute as (toolInput: unknown, ctx: unknown) => unknown,
    scope: tool.name,
  });
  const produced = execute(value, {
    abortSignal: input.abortSignal,
    messages: [],
    toolCallId: input.callId,
  });
  const output = isAsyncIterable(produced) ? await lastYielded(produced) : await produced;

  if (isAuthorizationSignal(output)) return { kind: "authorization-required", signal: output };
  return { kind: "output", modelOutput: await toModelOutput(tool, output, input.callId), output };
}

/** Streaming tools yield preliminary snapshots; the final one is the result. */
async function lastYielded(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}

async function toModelOutput(
  tool: ResolvedToolDefinition,
  output: unknown,
  toolCallId: string,
): Promise<ToolModelOutputValue> {
  if (tool.toModelOutput !== undefined) {
    return normalizeToolModelOutput({
      output: await tool.toModelOutput(output),
      toolCallId,
      toolName: tool.name,
    });
  }
  if (typeof output === "string") return { type: "text", value: output };
  return {
    type: "json",
    value: normalizeToolJsonOutput({
      boundary: "execute",
      output,
      toolCallId,
      toolName: tool.name,
    }) as JSONValue,
  };
}

// ---------------------------------------------------------------------------
// Interactive authorization attempts
// ---------------------------------------------------------------------------

interface PendingAttempt {
  callback?: AuthorizationCallback;
  readonly challenge: AuthorizationChallenge;
  readonly createdAt: number;
  readonly sessionId: string;
}

const ATTEMPT_TTL_MS = 30 * 60_000;
const ATTEMPT_MAX_ENTRIES = 1_024;
const pendingAttempts = new Map<string, PendingAttempt>();

function evictExpiredAttempts(now: number): void {
  for (const [attemptId, attempt] of pendingAttempts) {
    if (now - attempt.createdAt > ATTEMPT_TTL_MS) pendingAttempts.delete(attemptId);
  }
  while (pendingAttempts.size > ATTEMPT_MAX_ENTRIES) {
    const oldest = pendingAttempts.keys().next().value;
    if (oldest === undefined) break;
    pendingAttempts.delete(oldest);
  }
}

/**
 * Remembers the challenges a tool raised so the provider callback and the
 * client's retry can meet. Returns the attempt ids to put in request state.
 *
 * This store is per process. A callback or retry that lands on another
 * instance skips `completeAuthorization`; provider-owned strategies such as
 * Vercel Connect still succeed because the retried `getToken` reads the grant
 * the provider stored.
 */
export function recordCapabilityAuthorizationAttempts(
  sessionId: string,
  signal: AuthorizationSignal,
): string[] {
  const now = Date.now();
  evictExpiredAttempts(now);
  const attemptIds: string[] = [];
  for (const challenge of signal.challenges) {
    if (challenge.attemptId === undefined) continue;
    pendingAttempts.set(challenge.attemptId, { challenge, createdAt: now, sessionId });
    attemptIds.push(challenge.attemptId);
  }
  return attemptIds;
}

/** Stores a provider callback for a pending attempt. Returns false when unknown. */
export function recordCapabilityAuthorizationCallback(input: {
  readonly attemptId: string;
  readonly callback: AuthorizationCallback;
  readonly name: string;
}): boolean {
  evictExpiredAttempts(Date.now());
  const attempt = pendingAttempts.get(input.attemptId);
  if (attempt === undefined || attempt.challenge.name !== input.name) return false;
  attempt.callback = input.callback;
  return true;
}

/** Removes and returns the callback results for attempts owned by this session. */
export function takeCapabilityAuthorizationResults(
  sessionId: string,
  attemptIds: readonly string[],
): CapabilityAuthorizationResult[] {
  const results: CapabilityAuthorizationResult[] = [];
  for (const attemptId of attemptIds) {
    const attempt = pendingAttempts.get(attemptId);
    if (attempt === undefined || attempt.sessionId !== sessionId) continue;
    if (attempt.callback === undefined) continue;
    pendingAttempts.delete(attemptId);
    results.push({
      attemptId,
      callback: attempt.callback,
      hookUrl: attempt.challenge.hookUrl,
      instanceId: attempt.challenge.instanceId,
      name: attempt.challenge.name,
      principal: attempt.challenge.principal,
      resume: attempt.challenge.resume,
    });
  }
  return results;
}
