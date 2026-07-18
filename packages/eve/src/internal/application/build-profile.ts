import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

/** Version of the machine-readable `eve build --profile` report schema. */
export const APPLICATION_BUILD_PROFILE_SCHEMA_VERSION = 1 as const;

/** Deployment target represented by one build profile. */
export type ApplicationBuildProfileTarget = "local" | "vercel";

/** One completed phase in an application build profile. */
export interface ApplicationBuildProfilePhase {
  readonly durationMs: number;
  readonly name: string;
}

/** Size totals for one Vercel function directory in the published output. */
export interface ApplicationBuildProfileFunctionBundle {
  readonly files: number;
  readonly gzipBytes: number;
  readonly path: string;
  readonly rawBytes: number;
}

/** Final output-size measurements collected after a successful publication. */
export interface ApplicationBuildProfileOutput {
  readonly files: number;
  readonly functionBundles: readonly ApplicationBuildProfileFunctionBundle[];
  readonly gzipBytes: number;
  readonly rawBytes: number;
}

/** Timing data gathered while an application build runs. */
export interface ApplicationBuildProfileTiming {
  readonly durationMs: number;
  readonly phases: readonly ApplicationBuildProfilePhase[];
}

/** Stable JSON document written by `eve build --profile <path>`. */
export interface ApplicationBuildProfile {
  readonly durationMs: number;
  readonly kind: "eve-build-profile";
  readonly output: ApplicationBuildProfileOutput;
  readonly phases: readonly ApplicationBuildProfilePhase[];
  readonly schemaVersion: typeof APPLICATION_BUILD_PROFILE_SCHEMA_VERSION;
  readonly target: ApplicationBuildProfileTarget;
}

interface MutableOutputSize {
  files: number;
  gzipBytes: number;
  rawBytes: number;
}

interface FileSize {
  readonly gzipBytes: number;
  readonly rawBytes: number;
}

interface ApplicationBuildProfilerOptions {
  readonly now?: () => number;
}

function roundDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 10) / 10;
}

function createMutableOutputSize(): MutableOutputSize {
  return { files: 0, gzipBytes: 0, rawBytes: 0 };
}

function toOutputSize(
  size: MutableOutputSize,
): Omit<ApplicationBuildProfileOutput, "functionBundles"> {
  return {
    files: size.files,
    gzipBytes: size.gzipBytes,
    rawBytes: size.rawBytes,
  };
}

function toProfilePath(outputDirectory: string, directoryPath: string): string {
  return relative(outputDirectory, directoryPath).split(sep).join("/");
}

function measureFileSize(contents: Buffer): FileSize {
  return {
    gzipBytes: gzipSync(contents).byteLength,
    rawBytes: contents.byteLength,
  };
}

function addFileSize(size: MutableOutputSize, fileSize: FileSize): void {
  size.files += 1;
  size.rawBytes += fileSize.rawBytes;
  size.gzipBytes += fileSize.gzipBytes;
}

/**
 * Records elapsed build phases only when profile output was requested. The
 * injected clock keeps its serialization behavior independently testable.
 */
export class ApplicationBuildProfiler {
  readonly #now: () => number;
  readonly #phases: ApplicationBuildProfilePhase[] = [];
  readonly #startedAt: number;
  #finished = false;

  constructor(options: ApplicationBuildProfilerOptions = {}) {
    this.#now = options.now ?? performance.now.bind(performance);
    this.#startedAt = this.#now();
  }

  async measure<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.#finished) {
      throw new Error("Cannot record a phase after the build profile has finished.");
    }

    const startedAt = this.#now();
    try {
      return await operation();
    } finally {
      this.#phases.push({
        durationMs: roundDuration(this.#now() - startedAt),
        name,
      });
    }
  }

  finish(): ApplicationBuildProfileTiming {
    if (this.#finished) {
      throw new Error("The build profile has already finished.");
    }

    this.#finished = true;
    return {
      durationMs: roundDuration(this.#now() - this.#startedAt),
      phases: [...this.#phases],
    };
  }
}

/** Creates the versioned report shape from completed timings and output measurements. */
export function createApplicationBuildProfile(input: {
  readonly output: ApplicationBuildProfileOutput;
  readonly target: ApplicationBuildProfileTarget;
  readonly timing: ApplicationBuildProfileTiming;
}): ApplicationBuildProfile {
  return {
    durationMs: input.timing.durationMs,
    kind: "eve-build-profile",
    output: input.output,
    phases: input.timing.phases,
    schemaVersion: APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
    target: input.target,
  };
}

/**
 * Measures regular files in the published output without following symlinks.
 * Each `.func` directory receives its own subtotal for Vercel output.
 */
export async function measureApplicationBuildOutput(
  outputDirectory: string,
): Promise<ApplicationBuildProfileOutput> {
  const total = createMutableOutputSize();
  const functionBundles = new Map<string, MutableOutputSize>();

  const visit = async (
    directoryPath: string,
    activeFunctionBundle: string | undefined,
  ): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        const functionBundle = entry.name.endsWith(".func")
          ? toProfilePath(outputDirectory, entryPath)
          : activeFunctionBundle;
        await visit(entryPath, functionBundle);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const contents = await readFile(entryPath);
      const fileSize = measureFileSize(contents);
      addFileSize(total, fileSize);

      if (activeFunctionBundle !== undefined) {
        const functionBundle =
          functionBundles.get(activeFunctionBundle) ?? createMutableOutputSize();
        addFileSize(functionBundle, fileSize);
        functionBundles.set(activeFunctionBundle, functionBundle);
      }
    }
  };

  await visit(outputDirectory, undefined);

  return {
    ...toOutputSize(total),
    functionBundles: [...functionBundles.entries()]
      .map(([path, size]) => ({ path, ...toOutputSize(size) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/** Writes one formatted profile JSON document outside the build output. */
export async function writeApplicationBuildProfile(
  outputPath: string,
  profile: ApplicationBuildProfile,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}
