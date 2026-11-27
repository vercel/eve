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

export function noteBundledModules(listModuleIds: () => readonly string[]): void {
  if (recorders.size === 0) return;
  const moduleIds = listModuleIds();
  for (const recorder of recorders) {
    for (const moduleId of moduleIds) recorder.add(moduleId);
  }
}
