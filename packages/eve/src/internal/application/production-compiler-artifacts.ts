import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function stageProductionCompilerArtifacts(input: {
  readonly compilerArtifactsRoot: string;
  readonly outputDir: string;
}): Promise<void> {
  const destinationDirectory = join(input.outputDir, ".eve");

  await mkdir(dirname(destinationDirectory), { recursive: true });
  await cp(input.compilerArtifactsRoot, destinationDirectory, { recursive: true });
}
