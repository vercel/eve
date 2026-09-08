import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import {
  readChannelAuthenticationPayload,
  type ChannelAuthenticationPayload,
} from "#channel/authentication.js";
import { contextStorage } from "#context/container.js";
import type { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { createSessionContext } from "#context/providers/session.js";
import { serializeContext } from "#context/serialize.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { createAuthorizationAttempt, setPendingAuthorization } from "#harness/authorization.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  consumeDeferredStepInput,
  queueDeferredStepInput,
} from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { MatchedAuthorizationCallback } from "#execution/authorization-callback-match.js";
import { setChannelContext } from "#execution/channel-context.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { DurableStepResult } from "#execution/next-driver-action.js";
import { derivePendingState } from "#execution/pending-turn-state.js";
import type { TurnStepPayload } from "#execution/durable-session-migrations/turn-workflow.js";

export type ChannelAuthenticationEventEmitter = (
  event: UnstampedMessageStreamEvent,
) => Promise<MessageStreamEvent>;

export function createChannelAuthenticationEventEmitter(input: {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly ctx: ContextContainer;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly session: HarnessSession;
}): ChannelAuthenticationEventEmitter {
  return async (event) => {
    input.ctx.setVirtualContext(SessionKey, createSessionContext(input.ctx, input.session));
    const toEmit = await contextStorage.run(input.ctx, () =>
      callAdapterEventHandler(input.adapter, event, input.adapterCtx),
    );
    setChannelContext(input.ctx, {
      ...input.adapter,
      state: { ...input.adapterCtx.state },
    });
    const stamped = stampMessageStreamEvent(toEmit, input.ctx.get(TurnDeliveryIdsKey));
    const writer = input.parentWritable.getWriter();
    try {
      await writer.write(encodeMessageStreamEvent(stamped));
    } finally {
      writer.releaseLock();
    }
    return stamped;
  };
}

export async function completeChannelSenderAuthentication(input: {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly completedAuths: readonly MatchedAuthorizationCallback[] | undefined;
  readonly ctx: ContextContainer;
  readonly emit: ChannelAuthenticationEventEmitter;
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
}): Promise<{
  readonly completedAuths: readonly MatchedAuthorizationCallback[] | undefined;
  readonly resumedInput: StepInput | undefined;
  readonly session: HarnessSession;
}> {
  const senderAuths =
    input.completedAuths?.filter((match) => match.result.senderAuthentication !== undefined) ?? [];

  for (const match of senderAuths) {
    const sender = match.result.senderAuthentication!;
    if (input.adapter.completeSenderAuthentication === undefined) {
      throw new Error("The channel no longer supports the pending sender sign-in.");
    }
    const auth = await input.adapter.completeSenderAuthentication(
      {
        callback: match.result.callback,
        callbackUrl: match.result.hookUrl,
        event: sender.event,
        resume: match.result.resume,
        strategyIndex: sender.strategyIndex,
      },
      input.adapterCtx,
    );
    input.ctx.set(AuthKey, auth);
    if (!input.emissionState.sessionStarted && input.ctx.get(InitiatorAuthKey) == null) {
      input.ctx.set(InitiatorAuthKey, auth);
    }
    await input.emit(
      createAuthorizationCompletedEvent({
        attemptId: match.result.attemptId,
        authorization: match.authorization,
        name: match.result.name,
        outcome: "authorized",
        purpose: "session",
        sequence: input.emissionState.sequence,
        stepIndex: input.emissionState.stepIndex,
        turnId: activeTurnId(input.emissionState),
      }),
    );
  }

  const deferred =
    senderAuths.length === 0
      ? { input: undefined, session: input.session }
      : consumeDeferredStepInput({ session: input.session });
  const remaining = input.completedAuths?.filter(
    (match) => match.result.senderAuthentication === undefined,
  );
  return {
    completedAuths: remaining?.length === 0 ? undefined : remaining,
    resumedInput: deferred.input,
    session: deferred.session,
  };
}

export async function runChannelSenderAuthentication(input: {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly authentication: ChannelAuthenticationPayload | undefined;
  readonly ctx: ContextContainer;
  readonly emit: ChannelAuthenticationEventEmitter;
  readonly emissionState: HarnessEmissionState;
  readonly resolved: StepInput | undefined;
  readonly session: HarnessSession;
}): Promise<DurableStepResult | undefined> {
  if (input.authentication === undefined) return undefined;
  if (input.adapter.authenticateSender === undefined) {
    throw new Error("The channel does not support durable sender authentication.");
  }

  const attempt = contextStorage.run(input.ctx, () => createAuthorizationAttempt("session-auth"));
  const authentication = await input.adapter.authenticateSender(
    input.authentication.event,
    attempt?.hookUrl ?? "",
    input.adapterCtx,
  );
  if (authentication.kind === "not-authenticated") {
    throw new Error("The channel sender could not be authenticated.");
  }
  if (authentication.kind === "authenticated") {
    input.ctx.set(AuthKey, authentication.auth);
    if (!input.emissionState.sessionStarted && input.ctx.get(InitiatorAuthKey) == null) {
      input.ctx.set(InitiatorAuthKey, authentication.auth);
    }
    return undefined;
  }
  if (attempt === undefined) {
    throw new Error("Interactive sender sign-in requires a callback URL.");
  }
  if (input.resolved === undefined) {
    throw new Error("Interactive sender sign-in requires an accepted channel input.");
  }

  await input.emit(
    createAuthorizationRequiredEvent({
      attemptId: attempt.attemptId,
      authorization: authentication.challenge,
      description:
        authentication.challenge.instructions ?? "Sign in to continue this conversation.",
      name: "session-auth",
      purpose: "session",
      sequence: input.emissionState.sequence,
      stepIndex: input.emissionState.stepIndex,
      turnId: activeTurnId(input.emissionState),
      webhookUrl: attempt.hookUrl,
    }),
  );
  const parkedSession = queueDeferredStepInput(input.session, input.resolved);
  const session = {
    ...parkedSession,
    state: setPendingAuthorization(parkedSession.state, {
      challenges: [
        {
          attemptId: attempt.attemptId,
          challenge: authentication.challenge,
          hookUrl: attempt.hookUrl,
          name: "session-auth",
          resume: authentication.resume,
          senderAuthentication: {
            event: input.authentication.event,
            strategyIndex: authentication.strategyIndex,
          },
        },
      ],
    }),
  };
  return {
    action: "park",
    ...derivePendingState(session),
    serializedContext: serializeContext(input.ctx),
    sessionState: createDurableSessionState({ session }),
  };
}

export async function resolveAuthenticatedChannelInput(input: {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly completedAuths: readonly MatchedAuthorizationCallback[] | undefined;
  readonly ctx: ContextContainer;
  readonly emissionState: HarnessEmissionState;
  readonly failDelivery: (error: unknown) => Promise<void>;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly session: HarnessSession;
  readonly turnInput: TurnStepPayload | undefined;
}): Promise<{
  readonly completedAuths: readonly MatchedAuthorizationCallback[] | undefined;
  readonly parked: DurableStepResult | undefined;
  readonly resolved: StepInput | undefined;
  readonly session: HarnessSession;
}> {
  const emit = createChannelAuthenticationEventEmitter({
    adapter: input.adapter,
    adapterCtx: input.adapterCtx,
    ctx: input.ctx,
    parentWritable: input.parentWritable,
    session: input.session,
  });
  const completed = await completeChannelSenderAuthentication({
    adapter: input.adapter,
    adapterCtx: input.adapterCtx,
    completedAuths: input.completedAuths,
    ctx: input.ctx,
    emit,
    emissionState: input.emissionState,
    session: input.session,
  });

  let resolved: StepInput | undefined;
  if (input.turnInput?.kind === "deliver") {
    const results: StepInput[] = [];
    try {
      for (const payload of input.turnInput.payloads) {
        const result = input.adapter.deliver
          ? await input.adapter.deliver(payload, input.adapterCtx)
          : defaultDeliverResult(payload);
        if (result !== undefined && result !== null) results.push(result);
      }
    } catch (error) {
      await input.failDelivery(error);
      throw error;
    }
    resolved = results.length === 0 ? undefined : results.reduce(coalesceTurnInputs);
  } else if (input.turnInput?.kind === "runtime-action-result") {
    if (input.turnInput.acceptedAtMsByCallId !== undefined) {
      input.ctx.set(RuntimeActionSettlementTimesKey, input.turnInput.acceptedAtMsByCallId);
    }
    resolved = { runtimeActionResults: input.turnInput.results };
  }
  if (completed.resumedInput !== undefined) {
    resolved =
      resolved === undefined
        ? completed.resumedInput
        : coalesceTurnInputs(completed.resumedInput, resolved);
  }

  const authentication =
    input.turnInput?.kind === "deliver"
      ? input.turnInput.payloads
          .map((payload) => readChannelAuthenticationPayload(payload))
          .filter((value) => value !== undefined)
          .at(-1)
      : undefined;
  const parked = await runChannelSenderAuthentication({
    adapter: input.adapter,
    adapterCtx: input.adapterCtx,
    authentication,
    ctx: input.ctx,
    emit,
    emissionState: input.emissionState,
    resolved,
    session: completed.session,
  });
  return {
    completedAuths: completed.completedAuths,
    parked,
    resolved,
    session: completed.session,
  };
}
