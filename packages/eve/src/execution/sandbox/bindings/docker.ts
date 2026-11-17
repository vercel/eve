import { randomUUID } from "node:crypto";

import {
  assertDockerDaemonAvailable,
  createDockerCli,
  type DockerCli,
} from "#execution/sandbox/bindings/docker-cli.js";
import {
  createDockerConnection,
  type DockerSandboxExtensions,
} from "#execution/sandbox/bindings/docker-connection.js";
import {
  DOCKER_RESOURCES_MOUNT_PATH,
  runDockerBaseSetup,
  startDockerContainer,
} from "#execution/sandbox/bindings/docker-container.js";
import { assertDockerNetworkPolicy } from "#execution/sandbox/bindings/docker-network.js";
import {
  createDockerSandboxOptionsHash,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";
import {
  commitDockerTemplateImage,
  dockerImageExists,
  dockerTemplateImageReference,
  ensureDockerBaseImage,
  resolveDockerTemplateMarkerPath,
  touchDockerTemplateMarker,
} from "#execution/sandbox/bindings/docker-templates.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import {
  buildSandboxDockerfile,
  dockerfileImageReference,
  materializeSandboxDockerfile,
} from "#execution/sandbox/dockerfile.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";
import {
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type SandboxConnection,
  type SandboxJson,
  type SandboxProviderImplementation,
  type SandboxSessionContext,
} from "#public/sandbox/provider.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import {
  invalidPreparedSandboxArtifactError,
  invalidSandboxSessionStateError,
} from "#shared/sandbox-recorded-data-error.js";

export {
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker-templates.js";

export const DOCKER_PROVIDER_NAME = "docker";

type DockerSandboxPreparedArtifact = {
  readonly imageReference: string;
};
type DockerSandboxSessionState = {
  readonly containerName: string;
  readonly version: 2;
};

export type DockerSandboxProviderOptions = Omit<DockerSandboxEnvironmentOptions, "prepare">;

export function createDockerSandboxProvider(
  createOptions: DockerSandboxProviderOptions,
  dockerCli?: DockerCli,
): SandboxProviderImplementation<
  DockerSandboxRuntimeOptions,
  DockerSandboxPreparedArtifact,
  DockerSandboxSessionState,
  DockerSandboxExtensions
> {
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

  async function inspectContainerRunning(containerName: string): Promise<boolean | undefined> {
    const inspect = await cli.run([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (inspect.exitCode === 0) return inspect.stdout.trim() === "true";
    if (/no such (?:container|object)/iu.test(inspect.stderr)) return undefined;
    daemonCheck = undefined;
    expectDockerSuccess(inspect, `inspect sandbox session container "${containerName}"`);
    return undefined;
  }

  async function openDockerSession(
    context: SandboxSessionContext,
    openOptions: Readonly<DockerSandboxRuntimeOptions> | undefined,
    artifactValue: SandboxJson,
    containerName: string,
    createIfMissing: boolean,
  ): Promise<SandboxConnection<DockerSandboxExtensions>> {
    await ensureDaemon();
    let running = await inspectContainerRunning(containerName);
    if (running === undefined) {
      if (!createIfMissing) {
        throw new SandboxSessionGoneError(
          `Docker sandbox session container "${containerName}" no longer exists.`,
        );
      }
      const artifact = requirePreparedDockerArtifact(artifactValue);
      if (!(await dockerImageExists(cli, artifact.imageReference))) {
        throw new SandboxTemplateNotProvisionedError({
          providerName: DOCKER_PROVIDER_NAME,
          reason:
            "The Docker daemon has no image with that name: it was removed, for example by `docker image prune -a`, or the build used another Docker daemon.",
          templateKey: artifact.imageReference,
        });
      }
      try {
        await startDockerContainer({
          cli,
          containerName,
          image: artifact.imageReference,
          initialNetworkPolicy: openOptions?.networkPolicy ?? "allow-all",
          options,
          role: "session",
          tags: {
            agent: context.session.id,
            sessionId: context.session.id,
          },
        });
        running = true;
      } catch (error) {
        running = /is already in use/u.test(toErrorMessage(error))
          ? await inspectContainerRunning(containerName)
          : undefined;
        if (running === undefined) throw error;
      }
    }
    if (!running) {
      expectDockerSuccess(
        await cli.run(["start", containerName]),
        `restart sandbox session container "${containerName}"`,
      );
    }
    return createDockerConnection({
      cli,
      containerIdentity: await resolveDockerHandleIdentity(cli, containerName),
    });
  }

  return {
    async onSessionEnd(context, state, { signal }) {
      await ensureDaemon();
      const containerName = state?.containerName ?? dockerSessionName(context);
      const removed = await cli.run(["rm", "-f", containerName], { signal });
      if (removed.exitCode !== 0 && !/no such container/iu.test(removed.stderr)) {
        expectDockerSuccess(removed, `delete sandbox session container "${containerName}"`);
      }
    },
    async prepare(context) {
      context.log("checking Docker daemon");
      await ensureDaemon();
      const dockerfile = await materializeSandboxDockerfile({
        files: context.files,
        storagePath: context.storagePath,
      });
      const templateKey = context
        .templateKey({ dockerfile: dockerfile?.contentHash, optionsHash, version: 2 })
        .slice(0, 24);
      const templateReferenceInput = { optionsHash, templateKey };
      const imageReference = dockerTemplateImageReference(templateReferenceInput);
      const markerPath = resolveDockerTemplateMarkerPath(
        context.storagePath,
        templateReferenceInput,
      );

      context.log(`checking cached template image "${imageReference}"`);
      if (await dockerImageExists(cli, imageReference)) {
        context.log("reusing cached template image");
        await touchDockerTemplateMarker(markerPath, imageReference);
        return { imageReference };
      }

      const resourcesPath = await context.resourcesDirectory();
      let baseImage = options.image;
      if (dockerfile === undefined) {
        context.log(`checking base image "${options.image}"`);
        await ensureDockerBaseImage(cli, options);
      } else {
        baseImage = dockerfileImageReference({
          dockerfile,
          templateKey,
        });
        context.log(`building sandbox Dockerfile "${dockerfile.path}"`);
        await buildSandboxDockerfile({
          cli,
          dockerfile,
          imageReference: baseImage,
        });
      }

      const buildContainerName = `${templateKey}-build-${randomUUID().slice(0, 8)}`;
      context.log("starting template build container");
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
        context.log("preparing base runtime inside container");
        await runDockerBaseSetup(cli, buildContainerIdentity);
        await context.populate(
          createDockerConnection({ cli, containerIdentity: buildContainerIdentity }),
          resourcesPath === undefined ? undefined : { mountedAt: DOCKER_RESOURCES_MOUNT_PATH },
        );

        context.log("stopping template build container");
        expectDockerSuccess(
          await cli.run(["stop", "-t", "0", buildContainerIdentity]),
          `stop template build container "${buildContainerName}"`,
        );
        context.log(`committing template image "${imageReference}"`);
        const commit = await commitDockerTemplateImage({
          cli,
          containerIdentity: buildContainerIdentity,
          imageReference,
          templateKey,
        });
        if (commit === "reused") {
          context.log("reusing concurrently published template image");
        }
        await touchDockerTemplateMarker(markerPath, imageReference);
      } finally {
        await cli.run(["rm", "-f", buildContainerName]).catch(() => {});
        if (dockerfile !== undefined) {
          await cli.run(["rmi", baseImage]).catch(() => {});
        }
      }

      return { imageReference };
    },
    async resume(context, artifactValue, stateValue) {
      const state = requireDockerSessionState(stateValue);
      return await openDockerSession(context, undefined, artifactValue, state.containerName, false);
    },
    async start(context, openOptions, artifactValue) {
      if (openOptions?.networkPolicy !== undefined) {
        assertDockerNetworkPolicy(openOptions.networkPolicy);
      }
      const containerName = dockerSessionName(context);
      return {
        connection: await openDockerSession(
          context,
          openOptions,
          artifactValue,
          containerName,
          true,
        ),
        state: { containerName, version: 2 },
      };
    },
  };
}

function dockerSessionName(context: SandboxSessionContext): string {
  return `eve-sbx-${createSandboxProviderIdentity({
    namespace: context.storagePath,
    sessionId: context.session.id,
    version: 2,
  }).slice(0, 32)}`;
}

function requirePreparedDockerArtifact(artifact: SandboxJson): DockerSandboxPreparedArtifact {
  if (!isObject(artifact) || typeof artifact.imageReference !== "string") {
    throw invalidPreparedSandboxArtifactError("Docker sandbox");
  }
  return { imageReference: artifact.imageReference };
}

function requireDockerSessionState(state: SandboxJson): DockerSandboxSessionState {
  if (!isObject(state) || state.version !== 2 || typeof state.containerName !== "string") {
    throw invalidSandboxSessionStateError("Docker sandbox");
  }
  return { containerName: state.containerName, version: 2 };
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
