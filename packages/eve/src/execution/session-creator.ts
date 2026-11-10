import type { SessionAuthContext } from "#channel/types.js";
import { sessionAuthFromResult } from "#channel/auth/result.js";
import { getRun } from "#internal/workflow/runtime.js";

const NAMESPACE = "eve.session.creator";

export async function recordSessionCreator(
  sessionId: string,
  creator: SessionAuthContext | null,
): Promise<void> {
  const writer = getRun(sessionId)
    .getWritable<SessionAuthContext | null>({ namespace: NAMESPACE })
    .getWriter();
  try {
    await writer.write(creator === null ? null : sessionAuthFromResult(creator));
  } finally {
    writer.releaseLock();
  }
}

export async function readSessionCreator(
  sessionId: string,
): Promise<SessionAuthContext | null | undefined> {
  const stream = getRun(sessionId).getReadable<SessionAuthContext | null>({
    namespace: NAMESPACE,
  });
  try {
    if ((await stream.getTailIndex()) < 0) return undefined;
    const reader = stream.getReader();
    try {
      const first = await reader.read();
      return first.done ? undefined : first.value;
    } finally {
      reader.releaseLock();
    }
  } finally {
    await stream.cancel();
  }
}
