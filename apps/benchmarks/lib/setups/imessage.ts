import { readFileSync } from "node:fs";

import type { AuthoringSetup } from "../authoring-case.js";

const REGISTRY_PORT = 4173;
const REGISTRY_URL = `http://127.0.0.1:${REGISTRY_PORT}`;

export const imessageSetup: AuthoringSetup = {
  id: "imessage-v1",
  ports: [REGISTRY_PORT],
  environment: { EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL },
  async onBootstrap({ run, artifactsRoot, write }) {
    const setupRoot = `${artifactsRoot}/mock-imessage-setup`;
    await Promise.all(
      ["authoring-world.mjs", "cli.mjs", "package.json"].map((file) =>
        write(
          `${setupRoot}/${file}`,
          readFileSync(new URL(`./mock-imessage-setup/${file}`, import.meta.url), "utf8"),
        ),
      ),
    );
    await run(`pnpm add ./${setupRoot}`);
    await run(`mkdir -p ${artifactsRoot}/registry/channel`);

    const channel = {
      $schema: "https://ui.shadcn.com/schema/registry-item.json",
      name: "channel/photon-imessage",
      title: "Photon iMessage",
      description: "Connect an eve agent to iMessage through a deterministic provider setup flow.",
      files: [
        {
          path: "registry/channels/photon-imessage.ts",
          type: "registry:file",
          target: "agent/channels/imessage.ts",
          content:
            'import { photonIMessageChannel } from "eve/channels/photon";\n\nexport default photonIMessageChannel({ credentials: async () => ({ projectId: "mock-imessage-project", projectSecret: "mock-imessage-secret" }) });\n',
        },
      ],
      meta: {
        eve: {
          setup: {
            command: "mock-imessage-setup",
            package: "@eve-internal/mock-imessage-setup",
            bin: "mock-imessage-setup",
            args: [],
          },
        },
      },
      type: "registry:item",
    };
    const registry = {
      $schema: "https://ui.shadcn.com/schema/registry.json",
      name: "eve-authoring-eval",
      homepage: REGISTRY_URL,
      items: [
        {
          name: channel.name,
          type: "registry:item",
          description: channel.description,
          registry: `${REGISTRY_URL}/registry.json`,
          addCommandArgument: `${REGISTRY_URL}/channel/photon-imessage.json`,
        },
      ],
    };

    await Promise.all([
      write(`${artifactsRoot}/registry/registry.json`, JSON.stringify(registry)),
      write(`${artifactsRoot}/registry/channel/photon-imessage.json`, JSON.stringify(channel)),
    ]);
  },
  async onSession({ run, artifactsRoot, write }) {
    await run(
      `nohup python3 -m http.server ${REGISTRY_PORT} --directory ${artifactsRoot}/registry >${artifactsRoot}/registry.log 2>&1 </dev/null &`,
    );
    await write(
      ".claude/settings.json",
      JSON.stringify({ env: { EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL } }),
    );
  },
};
