import { getRun } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";

export interface RemoteChildBinding {
  readonly callId: string;
  readonly childSessionId: string;
  readonly name: string;
  readonly streamPath: string;
  readonly url: string;
  readonly resolverId?: string;
  readonly dynamicBinding?: JsonValue;
  readonly earlierProtocol?: number;
}

function namespaceOf(childSessionId: string): string {
  return `eve.child.${childSessionId}`;
}

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
  const { callId, dynamicBinding, earlierProtocol, name, resolverId, streamPath, url } = value;
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
  if (dynamicBinding !== undefined) binding.dynamicBinding = dynamicBinding as JsonValue;
  if (typeof earlierProtocol === "number") binding.earlierProtocol = earlierProtocol;
  return binding;
}
