import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function stageProductionStartArtifacts(input: {
  readonly compilerArtifactsRoot: string;
  readonly outputDir: string;
}): Promise<void> {
  const sourceDirectory = join(input.compilerArtifactsRoot, "compile");
  const destinationDirectory = join(input.outputDir, ".eve", "compile");

  await mkdir(dirname(destinationDirectory), { recursive: true });
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
}
