import { defineTool } from "eve/tools";
import { z } from "zod";

import { contentOf, FILES } from "../../constants";

export default defineTool({
  description: "Read one project file by name.",
  inputSchema: z.object({ file: z.enum(FILES as [string, ...string[]]) }),
  async execute({ file }) {
    return contentOf(file);
  },
});
