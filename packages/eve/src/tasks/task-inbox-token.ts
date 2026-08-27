/** Reads the non-secret task id embedded in a private task inbox token. */
export function readTaskIdFromInboxToken(token: string): string | undefined {
  const match = /^task:(task_[^:]+):[a-f0-9]{32}(?::subagent:[a-f0-9]+)?$/.exec(token);
  return match?.[1];
}
