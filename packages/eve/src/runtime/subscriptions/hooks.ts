import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import {
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type SubscriptionKeyMessage,
  type SubscriptionOwnerMessage,
  type SubscriptionKeySource,
} from "#runtime/subscriptions/state.js";

export async function findOwnerHook(bindingId: string) {
  try {
    return await getHookByToken(subscriptionHookToken(bindingId));
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
}

export async function resumeOwner(
  bindingId: string,
  message: SubscriptionOwnerMessage,
): Promise<boolean> {
  try {
    await resumeHook(subscriptionHookToken(bindingId), message);
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}

export async function resumeKey(
  source: SubscriptionKeySource,
  key: string,
  message: SubscriptionKeyMessage,
): Promise<string | undefined> {
  const token = subscriptionKeyHookToken(source, key);
  try {
    const { runId } = await getHookByToken(token);
    await resumeHook(token, message);
    return runId;
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
}
