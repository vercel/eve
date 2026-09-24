import { defineWorkflowTool, type WorkflowToolDefinition } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

interface Forecast {
  readonly city: string;
  readonly conditions: string;
  readonly highC: number;
}

const FORECASTS: Readonly<Record<string, Omit<Forecast, "city">>> = {
  lisbon: { conditions: "sunny", highC: 24 },
  oslo: { conditions: "light rain", highC: 9 },
};

// Slow on purpose: another message can arrive in the thread while the lookup runs.
async function execute({ city }: { city: string }): Promise<Forecast> {
  "use workflow";
  await sleep("15s");
  const forecast = FORECASTS[city.trim().toLowerCase()] ?? { conditions: "cloudy", highC: 15 };
  return { city, ...forecast };
}

const tool: WorkflowToolDefinition<{ city: string }, Forecast> = defineWorkflowTool({
  description: "Look up tomorrow's forecast for one city. Takes about 15 seconds.",
  inputSchema: z.object({ city: z.string().min(1) }),
  execute,
});

export default tool;
