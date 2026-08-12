import type { AuthoringSetup } from "../authoring-case.js";

const REGISTRY_PORT = 4173;
const REGISTRY_URL = `http://127.0.0.1:${REGISTRY_PORT}`;

export const imessageSetup: AuthoringSetup = {
  id: "imessage-v1",
  ports: [REGISTRY_PORT],
  environment: { EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL },
  async onBootstrap({ run, sourceRoot, write }) {
    await run(
      `npm install --save --package-lock=false ${sourceRoot}/apps/authoring-benchmarks/lib/setups/mock-imessage-setup`,
    );
    await run("mkdir -p __authoring_eval__/registry/channel");

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
      write("__authoring_eval__/registry/registry.json", JSON.stringify(registry)),
      write("__authoring_eval__/registry/channel/photon-imessage.json", JSON.stringify(channel)),
    ]);
  },
  async onSession({ run, write }) {
    await run(
      "nohup python3 -m http.server 4173 --directory __authoring_eval__/registry >__authoring_eval__/registry.log 2>&1 </dev/null &",
    );
    await write(
      ".claude/settings.json",
      JSON.stringify({ env: { EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL } }),
    );
  },
};
