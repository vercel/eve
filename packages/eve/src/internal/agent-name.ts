const PUBLIC_AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/** Whether a name is safe to expose as an eve public route segment. */
export function isValidPublicAgentName(name: string): boolean {
  return PUBLIC_AGENT_NAME_PATTERN.test(name);
}

/** Assert that an authored agent name is safe to expose publicly. */
export function assertValidPublicAgentName(name: string, subject: string): void {
  if (isValidPublicAgentName(name)) return;
  throw new Error(
    `${subject} ${JSON.stringify(name)} is invalid. Use lowercase letters, numbers, hyphens, or underscores, beginning and ending with a letter or number.`,
  );
}
