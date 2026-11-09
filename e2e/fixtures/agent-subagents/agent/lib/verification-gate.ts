/** The worker's hook token. The random per-eval key makes it a capability for only that gate. */
export const verificationToken = (sessionId: string, key: string) =>
  `nested-verification.${sessionId}.${key}`;
