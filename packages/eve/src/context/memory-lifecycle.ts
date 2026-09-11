import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import {
  PendingMemoryCommitKey,
  PreparedMemoryCompactionKey,
  PreparedMemoryPreambleKey,
  TurnMemoryLocksKey,
} from "#context/keys.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type {
  CompactionCompletedStreamEvent,
  CompactionRequestedStreamEvent,
  TurnCompletedStreamEvent,
  TurnStartedStreamEvent,
} from "#protocol/message.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import {
  defaultNamespace,
  type MemoryRecallResult,
  type MemoryScopeContext,
} from "#public/memory/index.js";
import type {
  InstrumentationMemoryOperation,
  InstrumentationMemoryRecord,
} from "#instrumentation/lifecycle.js";
import { instrumentMemoryOperation, type MemoryInstrumentation } from "#instrumentation/memory.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import {
  applyMemoryRecallBatches,
  createMemoryLock,
  projectMemoryHistory,
  validateMemoryRecallResult,
  type InternalMemoryLock,
  type MemoryRecallBatch,
} from "#shared/memory-state.js";

const fallbackAbortSignal = new AbortController().signal;
const log = createLogger("memory");

export function prepareMemoryPreamble(
  ctx: AlsContext,
  input: {
    readonly history: readonly ModelMessage[];
    readonly input: readonly ModelMessage[];
    readonly state?: Readonly<Record<string, unknown>>;
  },
): void {
  ctx.setVirtualContext(PreparedMemoryPreambleKey, {
    history: input.history,
    input: input.input,
    state: input.state,
  });
}

export async function dispatchMemoryTurnStarted(input: {
  readonly abortSignal?: AbortSignal;
  readonly appRoot: string;
  readonly ctx: AlsContext;
  readonly event: TurnStartedStreamEvent;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly nodeId: string;
  readonly instrumentation?: MemoryInstrumentation;
}): Promise<readonly ModelMessage[]> {
  const prepared = input.ctx.get(PreparedMemoryPreambleKey);
  if (prepared === undefined) return [];
  const turn = Object.freeze({
    id: input.event.data.turnId,
    input: Object.freeze([...prepared.input]),
    sequence: input.event.data.sequence,
  });
  const locks = Object.fromEntries(
    (
      await Promise.all(
        [...input.memories]
          .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
          .map(async (memory) => {
            const lock = await resolveMemoryLock({
              abortSignal: input.abortSignal ?? fallbackAbortSignal,
              appRoot: input.appRoot,
              ctx: input.ctx,
              memory,
              nodeId: input.nodeId,
              turn,
            });
            return lock === null ? null : ([memory.slot, lock] as const);
          }),
      )
    ).filter((entry): entry is readonly [string, InternalMemoryLock] => entry !== null),
  );
  input.ctx.set(TurnMemoryLocksKey, locks);

  const preRecallMessages = projectMemoryHistory({ locks, messages: prepared.history });
  const callbackContext = buildCallbackContext();
  const batches = (
    await Promise.all(
      [...input.memories]
        .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
        .map(async (memory): Promise<MemoryRecallBatch | null> => {
          const lock = locks[memory.slot];
          if (lock === undefined) return null;
          const operationId = memoryOperationId({
            phase: "turn.started",
            sequence: input.event.data.sequence,
            sessionId: callbackContext.session.id,
            slot: memory.slot,
            turnId: turn.id,
          });
          const result = await instrumentMemoryOperation(
            input.instrumentation,
            memoryInstrumentationOperation({
              operationId,
              operationName: "search_memory",
              phase: "turn.started",
              rootSessionId:
                callbackContext.session.parent?.rootSessionId ?? callbackContext.session.id,
              sessionId: callbackContext.session.id,
              slot: memory.slot,
              storeId: lock.scope.key,
              turnId: turn.id,
            }),
            async () => {
              const result = await memory.provider.recall["turn.started"]({
                ...callbackContext,
                abortSignal: input.abortSignal ?? fallbackAbortSignal,
                memory: { scope: lock.scope, slot: memory.slot },
                messages: preRecallMessages,
                operationId,
                turn,
              });
              const messages = validateMemoryRecallResult(result, memory.slot);
              return {
                outputRecords: memoryRecords(result),
                recordCount: messages.length,
                value: messages,
              };
            },
          );
          return {
            lock,
            messages: result,
            operationId,
          };
        }),
    )
  ).filter((batch): batch is MemoryRecallBatch => batch !== null);

  const committed = applyMemoryRecallBatches({
    batches,
    history: prepared.history,
    state: prepared.state,
  });
  const projectedMessages = [
    ...projectMemoryHistory({ locks, messages: committed.history }),
    ...prepared.input,
  ];
  input.ctx.setVirtualContext(PendingMemoryCommitKey, {
    history: committed.history,
    projectedMessages,
    state: committed.state,
  });
  return projectedMessages;
}

export function drainMemoryCommit(ctx: AlsContext) {
  const commit = ctx.get(PendingMemoryCommitKey);
  ctx.delete(PendingMemoryCommitKey);
  ctx.delete(PreparedMemoryPreambleKey);
  return commit;
}

export function prepareMemoryCompaction(
  ctx: AlsContext,
  input: {
    readonly history: readonly ModelMessage[];
    readonly state?: Readonly<Record<string, unknown>>;
  },
): void {
  ctx.setVirtualContext(PreparedMemoryCompactionKey, input);
}

export async function dispatchMemoryCompactionRequested(input: {
  readonly abortSignal?: AbortSignal;
  readonly appRoot: string;
  readonly ctx: AlsContext;
  readonly event: CompactionRequestedStreamEvent;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly nodeId: string;
  readonly instrumentation?: MemoryInstrumentation;
}): Promise<void> {
  const callbackContext = buildCallbackContext();
  const locks = await resolveCompactionLocks(input);
  input.ctx.set(TurnMemoryLocksKey, locks);
  const turn = input.event.data.turnId.length === 0 ? null : firstLockedTurn(locks);
  await Promise.all(
    [...input.memories]
      .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
      .map(async (memory) => {
        const lock = locks[memory.slot];
        const capture = memory.provider.capture?.["compaction.requested"];
        if (lock === undefined || capture === undefined) return;
        const operationId = memoryOperationId({
          phase: "compaction.requested",
          sequence: input.event.data.sequence,
          sessionId: callbackContext.session.id,
          slot: memory.slot,
          turnId: turn?.id ?? null,
        });
        await instrumentMemoryOperation(
          input.instrumentation,
          memoryInstrumentationOperation({
            operationId,
            operationName: "upsert_memory",
            phase: "compaction.requested",
            rootSessionId:
              callbackContext.session.parent?.rootSessionId ?? callbackContext.session.id,
            sessionId: callbackContext.session.id,
            slot: memory.slot,
            storeId: lock.scope.key,
            turnId: turn?.id,
          }),
          async () => {
            await capture({
              ...callbackContext,
              abortSignal: input.abortSignal ?? fallbackAbortSignal,
              compaction: {
                modelId: input.event.data.modelId,
                usageInputTokens: input.event.data.usageInputTokens,
              },
              memory: { scope: lock.scope, slot: memory.slot },
              messages: input.messages,
              operationId,
              turn,
            });
            return { value: undefined };
          },
        );
      }),
  );
}

export async function dispatchMemoryCompactionCompleted(input: {
  readonly abortSignal?: AbortSignal;
  readonly ctx: AlsContext;
  readonly event: CompactionCompletedStreamEvent;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly instrumentation?: MemoryInstrumentation;
}): Promise<readonly ModelMessage[]> {
  const prepared = input.ctx.get(PreparedMemoryCompactionKey);
  const rawHistory = prepared?.history ?? input.messages;
  const locks = input.ctx.get(TurnMemoryLocksKey) as
    | Readonly<Record<string, InternalMemoryLock>>
    | undefined;
  const activeLocks = locks ?? {};
  const projected = projectMemoryHistory({ locks: activeLocks, messages: rawHistory });
  const callbackContext = buildCallbackContext();
  const turn = input.event.data.turnId.length === 0 ? null : firstLockedTurn(activeLocks);
  const batches = (
    await Promise.all(
      [...input.memories]
        .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
        .map(async (memory): Promise<MemoryRecallBatch | null> => {
          const lock = activeLocks[memory.slot];
          const recall = memory.provider.recall["compaction.completed"];
          if (lock === undefined || recall === undefined) return null;
          const operationId = memoryOperationId({
            phase: "compaction.completed",
            sequence: input.event.data.sequence,
            sessionId: callbackContext.session.id,
            slot: memory.slot,
            turnId: turn?.id ?? null,
          });
          const result = await instrumentMemoryOperation(
            input.instrumentation,
            memoryInstrumentationOperation({
              operationId,
              operationName: "search_memory",
              phase: "compaction.completed",
              rootSessionId:
                callbackContext.session.parent?.rootSessionId ?? callbackContext.session.id,
              sessionId: callbackContext.session.id,
              slot: memory.slot,
              storeId: lock.scope.key,
              turnId: turn?.id,
            }),
            async () => {
              const result = await recall({
                ...callbackContext,
                abortSignal: input.abortSignal ?? fallbackAbortSignal,
                compaction: { modelId: input.event.data.modelId },
                memory: { scope: lock.scope, slot: memory.slot },
                messages: projected,
                operationId,
                turn,
              });
              const messages = validateMemoryRecallResult(result, memory.slot);
              return {
                outputRecords: memoryRecords(result),
                recordCount: messages.length,
                value: messages,
              };
            },
          );
          return {
            lock,
            messages: result,
            operationId,
          };
        }),
    )
  ).filter((batch): batch is MemoryRecallBatch => batch !== null);
  const committed = applyMemoryRecallBatches({
    batches,
    history: rawHistory,
    state: prepared?.state,
  });
  const projectedMessages = projectMemoryHistory({
    locks: activeLocks,
    messages: committed.history,
  });
  input.ctx.setVirtualContext(PendingMemoryCommitKey, {
    history: committed.history,
    projectedMessages,
    state: committed.state,
  });
  input.ctx.delete(PreparedMemoryCompactionKey);
  return projectedMessages;
}

export async function dispatchMemoryTurnCompleted(input: {
  readonly abortSignal?: AbortSignal;
  readonly ctx: AlsContext;
  readonly event: TurnCompletedStreamEvent;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly instrumentation?: MemoryInstrumentation;
}): Promise<void> {
  const locks = (input.ctx.get(TurnMemoryLocksKey) ?? {}) as Readonly<
    Record<string, InternalMemoryLock>
  >;
  const callbackContext = buildCallbackContext();
  const projected = projectMemoryHistory({ locks, messages: input.messages });
  await Promise.all(
    [...input.memories]
      .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
      .map(async (memory) => {
        const lock = locks[memory.slot];
        const capture = memory.provider.capture?.["turn.completed"];
        if (lock === undefined || capture === undefined) return;
        const operationId = memoryOperationId({
          phase: "turn.completed",
          sequence: input.event.data.sequence,
          sessionId: callbackContext.session.id,
          slot: memory.slot,
          turnId: input.event.data.turnId,
        });
        await instrumentMemoryOperation(
          input.instrumentation,
          memoryInstrumentationOperation({
            operationId,
            operationName: "upsert_memory",
            phase: "turn.completed",
            rootSessionId:
              callbackContext.session.parent?.rootSessionId ?? callbackContext.session.id,
            sessionId: callbackContext.session.id,
            slot: memory.slot,
            storeId: lock.scope.key,
            turnId: lock.turn.id,
          }),
          async () => {
            await capture({
              ...callbackContext,
              abortSignal: input.abortSignal ?? fallbackAbortSignal,
              memory: { scope: lock.scope, slot: memory.slot },
              messages: projected,
              operationId,
              turn: lock.turn,
            });
            return { value: undefined };
          },
        );
      }),
  );
}

async function resolveCompactionLocks(input: {
  readonly abortSignal?: AbortSignal;
  readonly appRoot: string;
  readonly ctx: AlsContext;
  readonly event: CompactionRequestedStreamEvent;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly nodeId: string;
}): Promise<Readonly<Record<string, InternalMemoryLock>>> {
  const existing = input.ctx.get(TurnMemoryLocksKey) as
    | Readonly<Record<string, InternalMemoryLock>>
    | undefined;
  if (input.event.data.turnId.length > 0 && existing !== undefined) return existing;
  const syntheticTurn = Object.freeze({ id: "", input: [], sequence: input.event.data.sequence });
  return Object.fromEntries(
    (
      await Promise.all(
        input.memories.map(async (memory) => {
          const lock = await resolveMemoryLock({
            abortSignal: input.abortSignal ?? fallbackAbortSignal,
            appRoot: input.appRoot,
            ctx: input.ctx,
            memory,
            nodeId: input.nodeId,
            turn: syntheticTurn,
          });
          return lock === null ? null : ([memory.slot, lock] as const);
        }),
      )
    ).filter((entry): entry is readonly [string, InternalMemoryLock] => entry !== null),
  );
}

function firstLockedTurn(
  locks: Readonly<Record<string, InternalMemoryLock>>,
): InternalMemoryLock["turn"] | null {
  return Object.values(locks)[0]?.turn ?? null;
}

async function resolveMemoryLock(input: {
  readonly abortSignal: AbortSignal;
  readonly appRoot: string;
  readonly ctx: AlsContext;
  readonly memory: ResolvedMemoryDefinition;
  readonly nodeId: string;
  readonly turn: InternalMemoryLock["turn"];
}): Promise<InternalMemoryLock | null> {
  const resolved = buildResolveContext(input.ctx, []);
  const scopeContext: MemoryScopeContext = {
    abortSignal: input.abortSignal,
    channel: resolved.channel,
    session: resolved.session,
  };
  const scopeValue =
    typeof input.memory.scope === "function"
      ? await input.memory.scope(scopeContext)
      : input.memory.scope;
  if (scopeValue === null) {
    reportDisabledMemorySlot(input.memory.slot, "scope");
    return null;
  }
  const namespaceContext = {
    appRoot: input.appRoot,
    node: input.nodeId,
    slot: input.memory.slot,
  };
  const namespaceValue =
    input.memory.namespace === undefined
      ? defaultNamespace(namespaceContext)
      : typeof input.memory.namespace === "function"
        ? await input.memory.namespace(namespaceContext)
        : input.memory.namespace;
  if (namespaceValue === null) {
    reportDisabledMemorySlot(input.memory.slot, "namespace");
    return null;
  }
  return createMemoryLock({
    namespace: namespaceValue,
    scope: scopeValue,
    slot: input.memory.slot,
    turn: input.turn,
    visibility: input.memory.visibility,
  });
}

function reportDisabledMemorySlot(slot: string, resolver: "namespace" | "scope"): void {
  if (!isEveDevEnvironment()) return;
  log.info("Memory slot is disabled for this operation", { resolver, slot });
}

export function memoryOperationId(input: {
  readonly phase: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly slot: string;
  readonly turnId: string | null;
}): string {
  return [
    "eve-memory-operation-v1",
    input.sessionId,
    String(input.sequence),
    input.turnId ?? "standalone",
    input.phase,
    input.slot,
  ].join(":");
}

function memoryInstrumentationOperation(input: {
  readonly operationId: string;
  readonly operationName: InstrumentationMemoryOperation["operationName"];
  readonly phase: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly slot: string;
  readonly storeId: string;
  readonly turnId?: string;
}): InstrumentationMemoryOperation {
  return {
    idempotencyKey: input.operationId,
    operationName: input.operationName,
    phase: input.phase,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    slot: input.slot,
    storeId: input.storeId,
    turnId: input.turnId,
  };
}

function memoryRecords(result: MemoryRecallResult): readonly InstrumentationMemoryRecord[] {
  if (result === null || result === undefined) return [];
  return result.messages.map((message) =>
    message.id === undefined
      ? { content: message.content }
      : { content: message.content, id: message.id },
  );
}
