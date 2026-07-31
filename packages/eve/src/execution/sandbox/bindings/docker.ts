import { randomUUID } from "node:crypto";

import {
  DOCKER_SANDBOX_LABEL,
  runDockerBaseSetup,
  startDockerContainer,
  stopDockerContainerIfRunning,
} from "#execution/sandbox/bindings/docker-container.js";
import {
  assertDockerDaemonAvailable,
  createDockerCli,
  type DockerCli,
} from "#execution/sandbox/bindings/docker-cli.js";
import { setDockerNetworkPolicy } from "#execution/sandbox/bindings/docker-network.js";
import {
  createDockerSandboxOptionsHash,
  decodeDockerSandboxCreateOptions,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";
import { createDockerInternalSession } from "#execution/sandbox/bindings/docker-session.js";
import {
  dockerImageExists,
  dockerTemplateImageReference,
  ensureDockerBaseImage,
  resolveDockerTemplateMarkerPath,
  touchDockerTemplateMarker,
} from "#execution/sandbox/bindings/docker-templates.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-errors.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { SandboxProviderContext } from "#shared/sandbox-value.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export {
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker-templates.js";

/**
 * Stable provider name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const DOCKER_PROVIDER = "docker";

export interface CreateDockerSandboxProviderInput {
  readonly createOptions?: DockerSandboxCreateOptions;
  /** Injectable Docker driver so provider logic is testable without a daemon. */
  readonly dockerCli?: DockerCli;
}

export interface DockerSandboxTemplateReference extends JsonObject {
  readonly image: string;
  readonly templateId: string;
}

export interface DockerSandboxReference extends JsonObject {
  readonly configuration: JsonObject;
  readonly containerId: string;
  readonly containerName: string;
  readonly sessionKey: string;
}

export interface DockerSandboxResource {
  readonly configuration: JsonObject;
  readonly containerId: string;
  readonly containerName: string;
  readonly session: SandboxSession;
  readonly sessionKey: string;
  shutdown(): Promise<void>;
}

export interface DockerSandboxProvider {
  create(input: {
    readonly context: SandboxProviderContext;
    readonly reference?: DockerSandboxReference;
    readonly template?: DockerSandboxTemplateReference;
  }): Promise<DockerSandboxResource>;
  prewarm(input: {
    readonly appRoot: string;
    readonly log?: (message: string) => void;
    readonly prepare: (resource: DockerSandboxResource) => Promise<void>;
    readonly templateId: string;
  }): Promise<DockerSandboxTemplateReference>;
}

export function createDockerSandboxProvider(
  input: CreateDockerSandboxProviderInput = {},
): DockerSandboxProvider {
  const cli = input.dockerCli ?? createDockerCli();
  const options = resolveDockerSandboxOptions(input.createOptions);
  const configuration = parseJsonObject(input.createOptions ?? {});
  const optionsHash = createDockerSandboxOptionsHash(options);
  let daemonCheck: Promise<void> | undefined;

  function ensureDaemon(): Promise<void> {
    daemonCheck ??= assertDockerDaemonAvailable(cli).catch((error: unknown) => {
      daemonCheck = undefined;
      throw error;
    });
    return daemonCheck;
  }

  return {
    async prewarm(prewarmInput): Promise<DockerSandboxTemplateReference> {
      prewarmInput.log?.("checking Docker daemon");
      await ensureDaemon();
      const templateReferenceInput = {
        optionsHash,
        templateKey: prewarmInput.templateId,
      };
      const imageReference = dockerTemplateImageReference(templateReferenceInput);
      const markerPath = resolveDockerTemplateMarkerPath(
        prewarmInput.appRoot,
        templateReferenceInput,
      );

      prewarmInput.log?.(`checking cached template image "${imageReference}"`);
      if (
        options.pullPolicy !== "always" &&
        isImmutableOciImageReference(options.image) &&
        (await dockerImageExists(cli, imageReference))
      ) {
        prewarmInput.log?.("reusing cached template image");
        await touchDockerTemplateMarker(markerPath, imageReference);
        return { image: imageReference, templateId: prewarmInput.templateId };
      }

      prewarmInput.log?.(`checking base image "${options.image}"`);
      await ensureDockerBaseImage(cli, options);

      const buildContainerName = `${prewarmInput.templateId}-build-${randomUUID().slice(0, 8)}`;
      prewarmInput.log?.("starting template build container");
      await startDockerContainer({
        cli,
        containerName: buildContainerName,
        image: options.image,
        initialNetworkPolicy: "allow-all",
        options,
        role: "template-build",
      });

      try {
        prewarmInput.log?.("preparing base runtime inside container");
        await runDockerBaseSetup(cli, buildContainerName);
        if (options.networkPolicy !== "allow-all") {
          prewarmInput.log?.("applying network policy");
          await setDockerNetworkPolicy(cli, buildContainerName, options.networkPolicy);
        }

        const templateSession = buildSandboxSession(
          createDockerInternalSession({
            cli,
            containerName: buildContainerName,
            id: prewarmInput.templateId,
          }),
          (policy) => setDockerNetworkPolicy(cli, buildContainerName, policy),
        );

        prewarmInput.log?.("running template preparation");
        await prewarmInput.prepare({
          configuration,
          containerId: buildContainerName,
          containerName: buildContainerName,
          session: createLoggingSandboxSession({
            log: prewarmInput.log,
            session: templateSession,
          }),
          sessionKey: prewarmInput.templateId,
          async shutdown() {},
        });

        // Quiesce before commit so the captured filesystem is stable.
        prewarmInput.log?.("stopping template build container");
        expectDockerSuccess(
          await cli.run(["stop", "-t", "0", buildContainerName]),
          `stop template build container "${buildContainerName}"`,
        );
        prewarmInput.log?.(`committing template image "${imageReference}"`);
        expectDockerSuccess(
          await cli.run([
            "commit",
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}=1`,
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}.role=template`,
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}.template-key=${prewarmInput.templateId}`,
            buildContainerName,
            imageReference,
          ]),
          `commit sandbox template image "${imageReference}"`,
        );
        await touchDockerTemplateMarker(markerPath, imageReference);
      } finally {
        await cli.run(["rm", "-f", buildContainerName]).catch(() => {});
      }

      return { image: imageReference, templateId: prewarmInput.templateId };
    },
    async create(createInput): Promise<DockerSandboxResource> {
      await ensureDaemon();
      const persistedIdentity =
        createInput.reference === undefined
          ? undefined
          : {
              id: createInput.reference.containerId,
              name: createInput.reference.containerName,
            };
      const sessionKey = createInput.reference?.sessionKey ?? createInput.context.resourceId;
      const containerName = persistedIdentity?.name ?? sessionKey;
      const existing = await inspectDockerContainer(cli, containerName);
      let containerId: string;

      if (existing !== null) {
        if (persistedIdentity !== undefined && existing.id !== persistedIdentity.id) {
          throw new SandboxResourceUnavailableError({
            provider: DOCKER_PROVIDER,
            sessionKey: containerName,
          });
        }
        containerId = existing.id;
        if (!existing.running) {
          expectDockerSuccess(
            await cli.run(["start", containerName]),
            `restart sandbox session container "${containerName}"`,
          );
        }
      } else {
        if (createInput.reference !== undefined) {
          throw new SandboxResourceUnavailableError({
            provider: DOCKER_PROVIDER,
            sessionKey: containerName,
          });
        }
        let image: string;
        if (createInput.template === undefined) {
          await ensureDockerBaseImage(cli, options);
          image = options.image;
        } else {
          image = createInput.template.image;
          if (!(await dockerImageExists(cli, image))) {
            throw new SandboxTemplateUnavailableError({
              provider: DOCKER_PROVIDER,
              templateKey: createInput.template.templateId,
            });
          }
          await touchDockerTemplateMarker(
            resolveDockerTemplateMarkerPath(createInput.context.appRoot, {
              optionsHash,
              templateKey: createInput.template.templateId,
            }),
            image,
          );
        }

        try {
          containerId = await startDockerContainer({
            cli,
            containerName,
            image,
            initialNetworkPolicy:
              createInput.template === undefined ? "allow-all" : options.networkPolicy,
            options,
            role: "session",
            tags: createInput.context.tags,
          });
        } catch (error) {
          if (createInput.template !== undefined) {
            throw new SandboxTemplateUnavailableError({
              provider: DOCKER_PROVIDER,
              templateKey: createInput.template.templateId,
            });
          }
          throw error;
        }

        if (createInput.template === undefined) {
          await runDockerBaseSetup(cli, containerName);
          if (options.networkPolicy !== "allow-all") {
            await setDockerNetworkPolicy(cli, containerName, options.networkPolicy);
          }
        }
      }

      const session = buildSandboxSession(
        createDockerInternalSession({ cli, containerName, id: sessionKey }),
        (policy) => setDockerNetworkPolicy(cli, containerName, policy),
      );

      return {
        configuration,
        containerId,
        containerName,
        session,
        sessionKey,
        // Session state lives in the container filesystem, so a stopped
        // container restarts with state intact on the next `create`.
        async shutdown() {
          await stopDockerContainerIfRunning(cli, containerName);
        },
      };
    },
  };
}

export function referenceDockerSandboxResource(
  resource: DockerSandboxResource,
): DockerSandboxReference {
  return {
    configuration: resource.configuration,
    containerId: resource.containerId,
    containerName: resource.containerName,
    sessionKey: resource.sessionKey,
  };
}

export async function restoreDockerSandboxResource(
  reference: DockerSandboxReference,
  context: SandboxProviderContext,
): Promise<DockerSandboxResource> {
  return await createDockerSandboxProvider({
    createOptions: decodeDockerSandboxCreateOptions(reference.configuration),
  }).create({ context, reference });
}

async function inspectDockerContainer(
  cli: DockerCli,
  containerName: string,
): Promise<{ readonly id: string; readonly running: boolean } | null> {
  const result = await cli.run([
    "container",
    "inspect",
    "--format",
    "{{.Id}} {{.State.Running}}",
    containerName,
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const match = /^(\S+) (true|false)$/.exec(result.stdout.trim());
  if (match === null) {
    throw new Error(`Docker returned invalid identity for sandbox container "${containerName}".`);
  }
  return {
    id: match[1]!,
    running: match[2] === "true",
  };
}

function isImmutableOciImageReference(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}
