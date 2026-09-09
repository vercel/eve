import type { ResumableTaskContext, ResumableTaskDefinition } from "./contracts.js";

export type Input = { reportId: string };
export type Checkpoint =
  | { phase: "fetch"; reportId: string }
  | { phase: "finished"; reportId: string; result: string };

function parseInput(value: unknown): Input {
  if (
    value === null ||
    typeof value !== "object" ||
    !("reportId" in value) ||
    typeof value.reportId !== "string" ||
    value.reportId.length === 0
  ) {
    throw new Error("Expected a reportId.");
  }
  return { reportId: value.reportId };
}

function parseCheckpoint(value: unknown): Checkpoint {
  const input = parseInput(value);
  if (value !== null && typeof value === "object" && "phase" in value) {
    if (value.phase === "fetch") return { phase: "fetch", ...input };
    if (value.phase === "finished" && "result" in value && typeof value.result === "string") {
      return { phase: "finished", ...input, result: value.result };
    }
  }
  throw new Error("Unknown report checkpoint.");
}

function parseOutput(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected report text.");
  return value;
}

function versionOne<T>(version: number, value: unknown, parse: (value: unknown) => T): T {
  if (version !== 1) throw new Error("Unsupported data version.");
  return parse(value);
}

async function drive(
  input: Input,
  saved: Checkpoint,
  context: ResumableTaskContext<Checkpoint>,
): Promise<string> {
  if (saved.phase === "finished") return saved.result;
  const result = await context.effect<string>({
    key: `fetch:${saved.reportId}`,
    definition: "effects/fetch-report",
    inputVersion: 1,
    input: { reportId: saved.reportId },
    checkpoint: saved,
  });
  await context.checkpoint({
    phase: "finished",
    reportId: input.reportId,
    result: result.value,
  });
  return result.value;
}

export const reportTask: ResumableTaskDefinition<Input, Checkpoint, string> = {
  inputVersion: 1,
  checkpointVersion: 1,
  inputSchema: { parse: parseInput },
  checkpointSchema: { parse: parseCheckpoint },
  outputSchema: { parse: parseOutput },
  start: (input, context) => drive(input, { phase: "fetch", reportId: input.reportId }, context),
  resume: drive,
  migrateInput: (version, value) => versionOne(version, value, parseInput),
  migrateCheckpoint: (version, value) => versionOne(version, value, parseCheckpoint),
};
