import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";
const SCENARIO = "TASK-REPORTING-PROBE";
const TASK_STATE_LABEL = "[Task state]\n";
const RESULTS = ["WAKE-MECHANISM", "CHANNEL-DELIVERY", "REPORTING-POLICY"] as const;
const DELAYS_MS = [10_000, 40_000, 70_000] as const;

interface TaskState {
  readonly tasks: readonly {
    readonly output?: {
      readonly data: unknown;
      readonly type: string;
    };
    readonly status: string;
  }[];
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const taskState = latestTaskState(request.userMessages);
  if (taskState !== undefined) {
    const alreadyReported = request.messages.some(
      (message) => message.role === "assistant" && message.text.startsWith("Consolidated report:"),
    );
    if (alreadyReported || taskState.tasks.some((task) => task.status === "pending")) {
      return EMPTY_DELIVERY_SENTINEL;
    }
    const results = taskState.tasks.flatMap((task) => {
      if (task.output?.type !== "result") return [];
      const result =
        task.output.data !== null && typeof task.output.data === "object"
          ? Reflect.get(task.output.data, "result")
          : undefined;
      return typeof result === "string" ? [result] : [];
    });
    return `Consolidated report: ${results.join(", ")}`;
  }

  if (!request.userMessages.some((message) => message.includes(SCENARIO))) {
    return `Mock reply: ${request.lastUserMessage ?? ""}`;
  }

  const probeResults = request.toolResults.filter((result) => result.name === "report_probe");
  if (probeResults.length > 0) return "investigation started";
  return {
    toolCalls: RESULTS.map((result, index) => ({
      id: `report-probe-${String(index + 1)}`,
      input: { delayMs: DELAYS_MS[index], result },
      name: "report_probe",
    })),
  };
}

function latestTaskState(messages: readonly string[]): TaskState | undefined {
  let message: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.startsWith(TASK_STATE_LABEL) === true) {
      message = candidate;
      break;
    }
  }
  if (message === undefined) return undefined;
  const parsed: unknown = JSON.parse(message.slice(TASK_STATE_LABEL.length));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray(Reflect.get(parsed, "tasks"))
  ) {
    throw new Error("Invalid task state supplied to the model.");
  }
  return parsed as TaskState;
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  // Compaction must erase history without introducing another model variable.
  compaction: {
    model: mockModel("Background report probe remains in progress."),
    modelContextWindowTokens: 1_000_000,
  },
  experimental: {
    ...base.experimental,
    tasks: true,
  },
  reasoning: "low",
});
