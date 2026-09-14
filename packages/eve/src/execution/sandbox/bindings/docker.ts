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
import { buildSandboxDockerfile, dockerfileImageReference } from "#execution/sandbox/dockerfile.js";
import {
  hydrateSandboxFromImmutableResources,
  prepareImmutableResources,
  resolveImmutableResourcesPath,
} from "#execution/sandbox/bindings/immutable-resources.js";
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-provider-utils.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import {
  isSandboxPreparedArtifactRecord,
  providerResourceRoot,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
  type SandboxProviderResources,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";

export {
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker-templates.js";

/**
 * Stable backend name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const DOCKER_PROVIDER_NAME = "docker";

/**
 * Creates the Docker sandbox provider.
 *
 * Two-phase lifecycle mapped onto Docker primitives:
 *
 * - `prewarm` runs the base image, applies base setup, runs the
 *   authored preparation, writes seed files, then `docker commit`s the
 *   container into a reusable template image.
 * - `create` starts (or restarts) one long-lived container per session
 *   key from the template image. The container's filesystem carries
 *   session state across reconnects, so `shutdown` only stops the
 *   container and the next `create` restarts it with state intact.
 */
export function createDockerSandboxProvider(
  createOptions?: DockerSandboxCreateOptions,
  dockerCli?: DockerCli,
): SandboxProviderImplementation<undefined, Record<string, unknown>> {
  const cli = dockerCli ?? createDockerCli();
  const options = resolveDockerSandboxOptions(createOptions);
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
    async prepare(context) {
      context.log?.("checking Docker daemon");
      await ensureDaemon();
      const templateReferenceInput = {
        optionsHash,
        templateKey: context.templateName,
      };
      const imageReference = dockerTemplateImageReference(templateReferenceInput);
      const resourceRoot = providerResourceRoot(context.resources);
      const resourcesPath =
        resourceRoot.key === undefined || resourceRoot.path === undefined
          ? undefined
          : await prepareImmutableResources({
              appRoot: context.appRoot,
              provider: DOCKER_PROVIDER_NAME,
              resourcesKey: resourceRoot.key,
              sourcePath: resourceRoot.path,
            });
      const markerPath = resolveDockerTemplateMarkerPath(context.appRoot, templateReferenceInput);

      context.log?.(`checking cached template image "${imageReference}"`);
      if (await dockerImageExists(cli, imageReference)) {
        context.log?.("reusing cached template image");
        await touchDockerTemplateMarker(markerPath, imageReference);
        return { artifact: { imageReference }, reused: true };
      }

      let baseImage = options.image;
      if (context.dockerfile === undefined) {
        context.log?.(`checking base image "${options.image}"`);
        await ensureDockerBaseImage(cli, options);
      } else {
        baseImage = dockerfileImageReference({
          dockerfile: context.dockerfile,
          templateKey: context.templateName,
        });
        context.log?.(`building sandbox Dockerfile "${context.dockerfile.path}"`);
        await buildSandboxDockerfile({
          cli,
          dockerfile: context.dockerfile,
          imageReference: baseImage,
        });
      }

      const buildContainerName = `${context.templateName}-build-${randomUUID().slice(0, 8)}`;
      context.log?.("starting template build container");
      await startDockerContainer({
        cli,
        containerName: buildContainerName,
        image: baseImage,
        initialNetworkPolicy: "allow-all",
        options,
        resourcesPath,
        role: "template-build",
      });

      try {
        const buildContainerIdentity = await resolveDockerHandleIdentity(cli, buildContainerName);
        context.log?.("preparing base runtime inside container");
        await runDockerBaseSetup(cli, buildContainerIdentity);
        if (options.networkPolicy !== "allow-all") {
          context.log?.("applying network policy");
          await setDockerNetworkPolicy(cli, buildContainerIdentity, options.networkPolicy);
        }

        const templateSession = buildSandboxSession(
          createDockerInternalSession({
            cli,
            containerIdentity: buildContainerIdentity,
            id: context.templateName,
          }),
          (policy) => setDockerNetworkPolicy(cli, buildContainerIdentity, policy),
        );

        if (resourcesPath === undefined) {
          await writeSandboxSeedFiles(templateSession, providerSeedFiles(context.resources));
        } else {
          context.log?.("hydrating workspace and skills from read-only resources");
          await hydrateSandboxFromImmutableResources(templateSession);
        }

        context.log?.("running sandbox preparation");
        await context.runPreparation(
          createLoggingSandboxSession({ log: context.log, session: templateSession }),
        );

        // Quiesce before commit so the captured filesystem is stable.
        context.log?.("stopping template build container");
        expectDockerSuccess(
          await cli.run(["stop", "-t", "0", buildContainerIdentity]),
          `stop template build container "${buildContainerName}"`,
        );
        context.log?.(`committing template image "${imageReference}"`);
        expectDockerSuccess(
          await cli.run([
            "commit",
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}=1`,
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}.role=template`,
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}.template-key=${context.templateName}`,
            buildContainerIdentity,
            imageReference,
          ]),
          `commit sandbox template image "${imageReference}"`,
        );
        await touchDockerTemplateMarker(markerPath, imageReference);
      } finally {
        await cli.run(["rm", "-f", buildContainerName]).catch(() => {});
      }

      return { artifact: { imageReference }, reused: false };
    },
    async getOrCreate(context, prepared) {
      await ensureDaemon();
      const containerName = getDockerContainerName(context.existing) ?? context.sandboxName;

      const inspect = await cli.run([
        "container",
        "inspect",
        "--format",
        "{{.State.Running}}",
        containerName,
      ]);

      if (inspect.exitCode === 0) {
        if (inspect.stdout.trim() !== "true") {
          expectDockerSuccess(
            await cli.run(["start", containerName]),
            `restart sandbox session container "${containerName}"`,
          );
        }
      } else {
        let image: string;
        if (prepared === undefined) {
          await ensureDockerBaseImage(cli, options);
          image = options.image;
        } else {
          const preparedImage = readPreparedDockerImage(prepared.artifact);
          if (preparedImage === undefined || !(await dockerImageExists(cli, preparedImage))) {
            throw new SandboxTemplateNotProvisionedError({
              providerName: DOCKER_PROVIDER_NAME,
              templateKey: prepared.templateName,
            });
          }
          image = preparedImage;
          await touchDockerTemplateMarker(
            resolveDockerTemplateMarkerPath(context.appRoot, {
              optionsHash,
              templateKey: prepared.templateName,
            }),
            image,
          );
        }

        try {
          const resourceRoot = providerResourceRoot(context.resources);
          await startDockerContainer({
            cli,
            containerName,
            image,
            initialNetworkPolicy: prepared === undefined ? "allow-all" : options.networkPolicy,
            options,
            resourcesPath:
              resourceRoot.key === undefined
                ? undefined
                : resolveImmutableResourcesPath({
                    appRoot: context.appRoot,
                    provider: DOCKER_PROVIDER_NAME,
                    resourcesKey: resourceRoot.key,
                  }),
            role: "session",
            tags: context.tags,
          });
        } catch (error) {
          if (prepared !== undefined) {
            throw new SandboxTemplateNotProvisionedError({
              providerName: DOCKER_PROVIDER_NAME,
              templateKey: prepared.templateName,
            });
          }
          throw error;
        }

        if (prepared === undefined) {
          await runDockerBaseSetup(cli, containerName);
          if (options.networkPolicy !== "allow-all") {
            await setDockerNetworkPolicy(cli, containerName, options.networkPolicy);
          }
        }
      }

      const containerIdentity = await resolveDockerHandleIdentity(cli, containerName);
      const session = buildSandboxSession(
        createDockerInternalSession({ cli, containerIdentity, id: context.sandboxName }),
        (policy) => setDockerNetworkPolicy(cli, containerIdentity, policy),
      );

      return context.handle({
        metadata: { containerName },
        sandbox: session,
        async delete() {
          await stopDockerContainerIfRunning(cli, containerIdentity);
          expectDockerSuccess(
            await cli.run(["rm", "-f", containerIdentity]),
            `delete sandbox session container "${containerName}"`,
          );
        },
        async stop() {
          await stopDockerContainerIfRunning(cli, containerIdentity);
        },
        // Session state lives in the container filesystem, so a stopped
        // container restarts with state intact on the next `create`.
        async shutdown() {
          await stopDockerContainerIfRunning(cli, containerIdentity);
        },
      });
    },
  };
}

function readPreparedDockerImage(
  artifact: SandboxPreparedArtifact | undefined,
): string | undefined {
  if (!isSandboxPreparedArtifactRecord(artifact)) return undefined;
  return typeof artifact.imageReference === "string" ? artifact.imageReference : undefined;
}

function providerSeedFiles(resources: SandboxProviderResources) {
  return [
    ...(resources.workspace?.files.map((file) => ({
      content: file.content,
      path: `${resources.workspace?.targetPath}/${file.relativePath}`,
    })) ?? []),
    ...(resources.skills?.files.map((file) => ({
      content: file.content,
      path: `${resources.skills?.targetPath}/${file.relativePath}`,
    })) ?? []),
  ];
}

function getDockerContainerName(metadata: Record<string, unknown> | undefined): string | undefined {
  const containerName = metadata?.containerName;
  return typeof containerName === "string" ? containerName : undefined;
}

async function resolveDockerHandleIdentity(cli: DockerCli, containerName: string): Promise<string> {
  const result = await cli.run(["container", "inspect", "--format", "{{.Id}}", containerName]);
  expectDockerSuccess(result, `resolve sandbox container identity for "${containerName}"`);
  const identity = result.stdout.trim();
  if (identity.length === 0) {
    throw new Error(`Docker returned an empty identity for sandbox container "${containerName}".`);
  }
  return identity;
}
