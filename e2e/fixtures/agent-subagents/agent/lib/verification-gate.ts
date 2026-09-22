import { getRun } from "workflow/api";

export const verificationNamespace = (key: string) => `nested-verification.${key}`;

export async function publishVerificationGate(sessionId: string, key: string, token: string) {
  "use step";
  const ops: Promise<void>[] = [];
  const writer = getRun(sessionId)
    .getWritable<string>({ namespace: verificationNamespace(key), ops })
    .getWriter();
  try {
    await writer.write(token);
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}
