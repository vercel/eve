const OPERATION_TOKEN_PREFIX = "eve:eve:op:";
const TASK_INPUT_TOKEN_PREFIX = "eve:task-input:";
const TOKEN_DIGEST = /^[a-f0-9]{32}$/;

/** Narrows one private create-once session token to task-input delivery only. */
export function createTaskInputCapabilityToken(operationToken: string): string {
  const digest = readTokenDigest(operationToken, OPERATION_TOKEN_PREFIX);
  if (digest === undefined) {
    throw new Error("Remote task input requires an eve create-once session capability.");
  }
  return `${TASK_INPUT_TOKEN_PREFIX}${digest}`;
}

/** Resolves a task-input capability to the create-once session hook it may address. */
export function readTaskInputTargetToken(capabilityToken: string): string | undefined {
  const digest = readTokenDigest(capabilityToken, TASK_INPUT_TOKEN_PREFIX);
  return digest === undefined ? undefined : `${OPERATION_TOKEN_PREFIX}${digest}`;
}

function readTokenDigest(token: string, prefix: string): string | undefined {
  if (!token.startsWith(prefix)) return undefined;
  const digest = token.slice(prefix.length);
  return TOKEN_DIGEST.test(digest) ? digest : undefined;
}
