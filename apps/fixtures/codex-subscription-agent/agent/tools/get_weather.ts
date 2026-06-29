import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: never(),
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  async execute({ city }) {
    return {
      city,
      condition: "Sunny",
      temperatureF: 72,
    };
  },
});
