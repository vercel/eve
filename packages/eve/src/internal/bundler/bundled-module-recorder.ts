const recorders = new Set<Set<string>>();

export async function recordBundledModules<T>(
  moduleIds: Set<string>,
  run: () => Promise<T>,
): Promise<T> {
  recorders.add(moduleIds);
  try {
    return await run();
  } finally {
    recorders.delete(moduleIds);
  }
}

export function noteBundledModules(moduleIds: readonly string[]): void {
  for (const recorder of recorders) {
    for (const moduleId of moduleIds) recorder.add(moduleId);
  }
}
