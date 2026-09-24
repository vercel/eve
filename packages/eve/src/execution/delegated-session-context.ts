/** Returns whether this session was created as a delegated child behind a parent input proxy. */
export function hasDelegatedSessionContext(
  serializedContext: Readonly<Record<string, unknown>>,
): boolean {
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}
