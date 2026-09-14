import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";
import { createFakePrompter } from "../../src/internal/testing/fake-prompter.js";
import { runRegistryFlow } from "../../src/setup/flows/registry.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import { getCompiledRuntimeAgentBundle } from "../../src/runtime/sessions/compiled-agent-cache.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "../../src/internal/application/runtime-compiled-artifacts-source.js";
const createAppRoot = useTemporaryAppRoots();
it("installs an addressed addition without a review and makes it available to the agent", async () => {
  const { appRoot, agentRoot } = await createAppRoot("eve-add-chat-");
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify({ name: "eve-add-chat", type: "module", dependencies: { eve: "*" } }),
  );
  await writeFile(join(agentRoot, "instructions.md"), "Help Alice with her work.\n");
  const content =
    "---\ndescription: Greet Alice when starting a conversation.\n---\nSay hello to Alice.\n";
  const item = {
    name: "greeting",
    type: "registry:file",
    files: [
      { path: "greeting.md", target: "agent/skills/greeting.md", type: "registry:file", content },
    ],
  };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(item));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a registry port");
    const fake = createFakePrompter();
    const result = await runRegistryFlow({
      appRoot,
      prompter: fake.prompter,
      initialAddress: `http://127.0.0.1:${address.port}/greeting.json`,
    });
    expect(result.kind).toBe("done");
    expect(fake.selectMessages).toEqual([]);
    expect(await readFile(join(agentRoot, "skills/greeting.md"), "utf8")).toBe(content);
    await compileAgent({ startPath: appRoot });
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot),
    });
    expect(bundle.resolvedAgent.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "greeting" })]),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
