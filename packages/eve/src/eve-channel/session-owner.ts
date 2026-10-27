import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import { getRun } from "#internal/workflow/runtime.js";
import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import { isObject } from "#shared/guards.js";

const OWNER_NAMESPACE = "eve.http.session-owner.v1";

function ownerKey(caller: SessionAuthContext): string {
  const authority =
    caller.issuer === undefined
      ? ["authenticator", caller.authenticator]
      : ["issuer", caller.issuer];
  return createHash("sha256")
    .update(JSON.stringify([caller.principalType, authority, caller.principalId]))
    .digest("hex");
}

async function readOwner(sessionId: string): Promise<unknown> {
  const stream = getRun(sessionId).getReadable<unknown>({ namespace: OWNER_NAMESPACE });
  try {
    if ((await stream.getTailIndex()) < 0) return undefined;
    const reader = stream.getReader();
    try {
      const first = await reader.read();
      return first.done ? undefined : first.value;
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return undefined;
    throw error;
  } finally {
    void stream.cancel().catch(() => {});
  }
}

/** Publishes ownership before returning an HTTP-created session to its caller. */
export async function recordHttpSessionOwner(
  sessionId: string,
  caller: SessionAuthContext,
): Promise<void> {
  if (caller.principalType !== "user") return;
  const key = ownerKey(caller);
  const existing = await readOwner(sessionId);
  if (existing !== undefined) {
    if (!isObject(existing) || existing.key !== key)
      throw new Error("The session already has a different HTTP owner.");
    return;
  }
  const ops: Promise<unknown>[] = [];
  const writer = getRun(sessionId)
    .getWritable<{ key: string }>({ namespace: OWNER_NAMESPACE, ops })
    .getWriter();
  try {
    await writer.write({ key });
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}

/** Ownership is independent of mutable turn auth and survives workflow-input retention. */
export async function isHttpSessionOwner(
  sessionId: string,
  caller: SessionAuthContext,
): Promise<boolean> {
  if (caller.principalType !== "user") return false;
  const owner = await readOwner(sessionId);
  return isObject(owner) && owner.key === ownerKey(caller);
}
