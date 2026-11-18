const workspaceTails = new Map<string, Promise<void>>();

export async function withSelfModificationWorkspaceLock<T>(
  workspaceKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = workspaceTails.get(workspaceKey) ?? Promise.resolve();
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => acquired);
  workspaceTails.set(workspaceKey, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (workspaceTails.get(workspaceKey) === tail) workspaceTails.delete(workspaceKey);
  }
}
