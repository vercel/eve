import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { startProductionServer } from "./start-production-server.js";

async function findFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

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

  it("fails when another process already holds the requested port", async () => {
    const occupant = createServer((_request, response) => response.end("not eve"));
    await new Promise<void>((resolveListen) => occupant.listen(0, "127.0.0.1", resolveListen));
    const { port } = occupant.address() as AddressInfo;
    const { appRoot } = await createApp("eve-production-port-taken-", {
      files: {
        // Like srvx: a failed bind is logged and sets exitCode, while other
        // work keeps the process alive.
        ".output/server/index.mjs": [
          'import { createServer } from "node:http";',
          "createServer()",
          "  .listen(Number(process.env.PORT), process.env.HOST)",
          '  .once("error", (error) => {',
          '    console.error("[srvx] Failed to start server:", error);',
          "    process.exitCode = 1;",
          "  });",
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      },
    });

    const started = startProductionServer(appRoot, { host: "127.0.0.1", port });
    try {
      await expect(started).rejects.toThrow(`Port ${port} on 127.0.0.1 is already in use.`);
    } finally {
      await started.then(
        (server) => server.close(),
        () => undefined,
      );
      await new Promise((resolveClose) => occupant.close(resolveClose));
    }
  });

  it("fails when another process takes the port before the server binds", async () => {
    const port = await findFreePort();
    const { appRoot } = await createApp("eve-production-port-race-", {
      files: {
        // A separate process wins the port first, like a second `eve start`
        // on the same port. Then the srvx-like bind fails and leaves this
        // process alive. The winner exits when this process does.
        ".output/server/index.mjs": [
          'import { spawn } from "node:child_process";',
          'import { createServer } from "node:http";',
          "const winner = spawn(process.execPath, [",
          '  "-e",',
          '  `require("node:http").createServer((_q, s) => s.end("not eve"))',
          '    .listen(${process.env.PORT}, ${JSON.stringify(process.env.HOST)}, () => console.log("up"));',
          '   process.stdin.on("end", () => process.exit()).resume();`,',
          '], { stdio: ["pipe", "pipe", "inherit"] });',
          'winner.stdout.once("data", () => {',
          "  createServer()",
          "    .listen(Number(process.env.PORT), process.env.HOST)",
          '    .once("error", (error) => {',
          '      console.error("[srvx] Failed to start server:", error);',
          "      process.exitCode = 1;",
          "    });",
          "});",
        ].join("\n"),
      },
    });

    const started = startProductionServer(appRoot, { host: "127.0.0.1", port });
    try {
      await expect(started).rejects.toThrow(`Port ${port} on 127.0.0.1 is already in use.`);
    } finally {
      await started.then(
        (server) => server.close(),
        () => undefined,
      );
    }
  });
});
