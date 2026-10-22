import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeclarationCopier } from "../_shared.mjs";

const copy = createDeclarationCopier({
  files: ({ distEntries }) =>
    [
      ...distEntries.filter((file) => file.endsWith(".d.ts")),
      "mcp/events.d.ts",
      "mcp/verify-event.d.ts",
      "internal/event-request.d.ts",
    ].map((file) => ({ source: file, output: file })),
});

/** Receipt and saved-watch management do not require an authored Connect provider. */
export default {
  packageName: "@vercel/connect",
  compiledPath: "@vercel/connect-events",
  bundling: "standalone",
  entries: [
    {
      input: fileURLToPath(new URL("../entries/@vercel/connect-events.mjs", import.meta.url)),
      outputPath: "index",
    },
  ],
  async copyDeclarations(ctx) {
    await copy(ctx);
    await writeFile(
      join(ctx.destinationRoot, "index.d.ts"),
      'export { getSubscription, unsubscribe } from "./mcp/events.js";\nexport { verifyMcpEvent } from "./mcp/verify-event.js";\n',
    );
  },
};
