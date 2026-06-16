import { resolve } from "node:path";

export interface DevelopmentRebuildHandle {
  flush(): Promise<void>;
}

const developmentRebuildHandles = new Map<string, DevelopmentRebuildHandle>();

export function registerDevelopmentRebuildHandle(
  appRoot: string,
  handle: DevelopmentRebuildHandle,
): () => void {
  const key = resolve(appRoot);
  developmentRebuildHandles.set(key, handle);

  return () => {
    if (developmentRebuildHandles.get(key) === handle) {
      developmentRebuildHandles.delete(key);
    }
  };
}

export async function flushDevelopmentRebuild(appRoot: string): Promise<void> {
  await developmentRebuildHandles.get(resolve(appRoot))?.flush();
}
