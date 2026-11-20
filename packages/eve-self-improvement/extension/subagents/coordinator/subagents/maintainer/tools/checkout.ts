import { defineTool } from "eve/tools";
import { z } from "zod";
import extension from "../../../../../extension.js";
import { authorizedActive } from "../../../../../lib/publish.js";
import { checkout, repositoryPath } from "../../../../../lib/hosted.js";

export default defineTool({
  description:
    "Check out the authorized active experiment's immutable source in this sandbox. No reusable repository credentials are supplied to processes.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const active = await authorizedActive(extension.config, ctx);
    await checkout(
      extension.config,
      await ctx.getSandbox(),
      active.experiment.candidate?.head ?? active.experiment.base,
    );
    return {
      path: repositoryPath,
      applicationDirectory: extension.config.repository.directory,
      sha: active.experiment.candidate?.head ?? active.experiment.base,
    };
  },
});
