const PUBLIC_AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

function isValidPublicAgentName(name: string): boolean {
  return PUBLIC_AGENT_NAME_PATTERN.test(name);
}

export function assertValidPublicAgentName(name: string, subject: string): void {
  if (isValidPublicAgentName(name)) return;
  throw new Error(
    `${subject} ${JSON.stringify(name)} is invalid. Use lowercase letters, numbers, hyphens, or underscores, beginning and ending with a letter or number.`,
  );
}
