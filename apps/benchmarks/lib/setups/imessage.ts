import { readFileSync } from "node:fs";

import type { AuthoringSetup } from "../authoring-case.js";
import { AUTHORING_EVAL_DIRECTORY, AUTHORING_EVAL_DIRECTORY_ENV } from "../paths.js";

const REGISTRY_PORT = 4173;
const REGISTRY_URL = `http://127.0.0.1:${REGISTRY_PORT}`;

/**
 * Serves a local registry whose iMessage channel declares a deterministic setup command,
 * and installs that command's package in the project. The setup command records the
 * provider world the grader reads.
 */
export const imessageSetup: AuthoringSetup = {
  id: "imessage-v2",
  environment: {
    EVE_DEV_OFFICIAL_REGISTRY_URL: REGISTRY_URL,
    [AUTHORING_EVAL_DIRECTORY_ENV]: AUTHORING_EVAL_DIRECTORY,
  },
  async onSession({ run, artifactsRoot, write }) {
    // Inside the workspace: npm records a relative `file:` path, and agent-eval moves the
    // workspace after setup, so a path outside it would no longer resolve.
    const setupRoot = ".fixtures/photon-imessage-setup";
    await Promise.all(
      ["authoring-world.mjs", "cli.mjs", "package.json"].map((file) =>
        write(
          `${setupRoot}/${file}`,
          readFileSync(new URL(`./mock-imessage-setup/${file}`, import.meta.url), "utf8"),
        ),
      ),
    );
    await run(`npm install --save-dev ./${setupRoot}`);
    await run(`mkdir -p ${artifactsRoot}/registry/channel`);

    const channel = {
      $schema: "https://ui.shadcn.com/schema/registry-item.json",
      name: "channel/photon-imessage",
      title: "Photon iMessage",
      description: "Connect an eve agent to iMessage through Photon.",
      files: [
        {
          path: "registry/channels/photon-imessage.ts",
          type: "registry:file",
          target: "agent/channels/imessage.ts",
          content:
            'import { photonIMessageChannel } from "eve/channels/photon";\n\nexport default photonIMessageChannel({\n  async credentials() {\n    const projectId = process.env.IMESSAGE_PROJECT_ID;\n    const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;\n    if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");\n    return { projectId, projectSecret };\n  },\n  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,\n});\n',
        },
      ],
      meta: {
        eve: {
          setup: {
            command: "photon-imessage-setup",
            package: "@photon-hq/eve-imessage-setup",
            bin: "photon-imessage-setup",
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
    await run(
      `nohup python3 -m http.server ${REGISTRY_PORT} --directory ${artifactsRoot}/registry >${artifactsRoot}/registry.log 2>&1 </dev/null &`,
    );
  },
};
