const activeBuilds = new Map<string, Promise<void>>();

export async function runQueuedWorkflowBuild(
  outputDirectory: string,
  build: () => Promise<void>,
): Promise<void> {
  const previousBuild = activeBuilds.get(outputDirectory) ?? Promise.resolve();
  const nextBuild = previousBuild.then(build, build);
  activeBuilds.set(outputDirectory, nextBuild);

  try {
    await nextBuild;
  } finally {
    if (activeBuilds.get(outputDirectory) === nextBuild) {
      activeBuilds.delete(outputDirectory);
    }
  }
}
