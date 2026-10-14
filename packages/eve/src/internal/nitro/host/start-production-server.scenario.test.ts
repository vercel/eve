import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { startProductionServer } from "./start-production-server.js";

describe("production server output", () => {
  const createApp = useTemporaryAppRoots();

  it.each(["stdout", "stderr"] as const)(
    "releases startup %s and stops retaining output after readiness",
    async (stream) => {
      const { appRoot } = await createApp("eve-production-output-", {
        files: {
          "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
          "agent/instructions.md": "Help with the user's requests.",
          ".output/server/index.mjs": [
            'import { createServer } from "node:http";',
            "const server = createServer((_request, response) => {",
            '  response.end("done", () => {',
            `    process.${stream}.write("runtime-output-marker\\n", () => {`,
            "      server.close(() => { process.exitCode = 23; });",
            "    });",
            "  });",
            "});",
            "server.listen(Number(process.env.PORT), process.env.HOST, () => {",
            `  process.${stream}.write("startup-output-marker\\n");`,
            "  console.log(`Listening on http://${process.env.HOST}:${process.env.PORT}/`);",
            "});",
          ].join("\n"),
        },
      });
      const artifactsRoot = join(appRoot, ".output", ".eve");
      await compileAgentInWorkspace({
        artifactLocations: { publishedRoot: artifactsRoot, writeRoot: artifactsRoot },
        startPath: appRoot,
      });

      const server = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(server.url);
        expect(await response.text()).toBe("done");
        await expect(server.wait()).rejects.toThrow("code=23");
        await expect.soft(server.wait()).rejects.not.toThrow("startup-output-marker");
        await expect.soft(server.wait()).rejects.not.toThrow("runtime-output-marker");
      } finally {
        await server.close();
      }
    },
  );
});
