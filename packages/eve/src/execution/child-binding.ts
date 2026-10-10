// Where a remote child session runs, and which credential resolver reaches it. The binding is
// private: it rides a side stream on the parent session's anchor run, written before the parent's
// `child.opened`, and only the parent's stream proxy reads it.

import { getRun } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

/** What the parent's proxy route needs to reach one remote child's stream. */
export interface RemoteChildBinding {
  readonly callId: string;
  readonly childSessionId: string;
  readonly name: string;
  /** The proxy route the parent's `child.opened` names. */
  readonly streamPath: string;
  readonly url: string;
  readonly resolverId?: string;
  /** The child's remote agent protocol, when it speaks an earlier one: the proxy can't follow it. */
  readonly earlierProtocol?: number;
}

function namespaceOf(childSessionId: string): string {
  return `eve.child.${childSessionId}`;
}

/** Records a remote child's binding on the parent session's stream, before its `child.opened`. */
export async function recordRemoteChildBinding(
  parentSessionId: string,
  binding: RemoteChildBinding,
): Promise<void> {
  const writer = getRun(parentSessionId)
    .getWritable<RemoteChildBinding>({ namespace: namespaceOf(binding.childSessionId) })
    .getWriter();
  try {
    await writer.write(binding);
  } finally {
    writer.releaseLock();
  }
}

/** Reads a remote child's binding from its parent session, or `undefined` when none was recorded. */
export async function readRemoteChildBinding(
  parentSessionId: string,
  childSessionId: string,
): Promise<RemoteChildBinding | undefined> {
  const stream = getRun(parentSessionId).getReadable<unknown>({
    namespace: namespaceOf(childSessionId),
  });
  try {
    if ((await stream.getTailIndex()) < 0) return undefined;
    const reader = stream.getReader();
    const first = await reader.read();
    reader.releaseLock();
    return first.done ? undefined : parseBinding(first.value, childSessionId);
  } finally {
    await stream.cancel().catch(() => {});
  }
}

function parseBinding(value: unknown, childSessionId: string): RemoteChildBinding | undefined {
  if (!isObject(value)) return undefined;
  const { callId, earlierProtocol, name, resolverId, streamPath, url } = value;
  if (
    typeof callId !== "string" ||
    typeof name !== "string" ||
    typeof streamPath !== "string" ||
    typeof url !== "string"
  )
    return undefined;
  const binding: { -readonly [K in keyof RemoteChildBinding]: RemoteChildBinding[K] } = {
    callId,
    childSessionId,
    name,
    streamPath,
    url,
  };
  if (typeof resolverId === "string") binding.resolverId = resolverId;
  if (typeof earlierProtocol === "number") binding.earlierProtocol = earlierProtocol;
  return binding;
}
