import { getRun } from "workflow/api";

export const verificationNamespace = (key: string) => `nested-verification.${key}`;

export interface VerificationGate {
  readonly token: string;
  readonly runId: string;
}

export async function publishVerificationGate(
  sessionId: string,
  key: string,
  gate: VerificationGate,
) {
  "use step";
  const ops: Promise<void>[] = [];
  const writer = getRun(sessionId)
    .getWritable<VerificationGate>({ namespace: verificationNamespace(key), ops })
    .getWriter();
  try {
    await writer.write(gate);
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}
