import type { MutableNetworkSandboxSession } from "#shared/sandbox-session.js";
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
import {
  buildSandboxDockerfile,
  dockerfileImageReference,
  materializeSandboxDockerfile,
} from "#execution/sandbox/dockerfile.js";
import {
  hydrateSandboxProviderResources,
  prepareImmutableResources,
} from "#execution/sandbox/bindings/immutable-resources.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import {
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import type {
  DockerSandboxEnvironmentOptions,
  DockerSandboxRuntimeOptions,
} from "#public/sandbox/docker-sandbox.js";

export {
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker-templates.js";

/**
 * Stable provider name used for prepared-artifact storage and provider identity.
 */
export const DOCKER_PROVIDER_NAME = "docker";

type DockerSandboxPreparedArtifact = {
  readonly imageReference: string;
};
type DockerSandboxSessionState = {
  readonly containerName: string;
  readonly generation: string;
  readonly version: 2;
};

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
  createOptions?: DockerSandboxEnvironmentOptions,
  dockerCli?: DockerCli,
): SandboxProviderImplementation<
  DockerSandboxRuntimeOptions,
  DockerSandboxPreparedArtifact,
  DockerSandboxSessionState,
  MutableNetworkSandboxSession
> {
  const cli = dockerCli ?? createDockerCli();
  const authoredOptions = createOptions ?? {};
  const options = resolveDockerSandboxOptions(authoredOptions);
  const optionsHash = createDockerSandboxOptionsHash(options);
  let daemonCheck: Promise<void> | undefined;

  function ensureDaemon(): Promise<void> {
    daemonCheck ??= assertDockerDaemonAvailable(cli).catch((error: unknown) => {
      daemonCheck = undefined;
      throw error;
    });
    return daemonCheck;
  }

  async function openDockerSession(
    context: SandboxProviderSessionContext,
    openOptions: Readonly<DockerSandboxRuntimeOptions> | undefined,
    artifactValue: SandboxPreparedArtifact,
    containerName: string,
    createIfMissing: boolean,
  ) {
    await ensureDaemon();
    const artifact = requirePreparedDockerArtifact(artifactValue);
    if (!(await dockerImageExists(cli, artifact.imageReference))) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: DOCKER_PROVIDER_NAME,
        templateKey: artifact.imageReference,
      });
    }
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
      if (!createIfMissing) {
        throw new Error(`Docker sandbox session container "${containerName}" no longer exists.`);
      }
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
    }
    const containerIdentity = await resolveDockerHandleIdentity(cli, containerName);
    const session = buildSandboxSession(
      createDockerInternalSession({ cli, containerIdentity }),
      (policy) => setDockerNetworkPolicy(cli, containerIdentity, policy),
    );
    return {
      sandbox: session,
      async onSessionDelete() {
        await stopDockerContainerIfRunning(cli, containerIdentity);
        expectDockerSuccess(
          await cli.run(["rm", "-f", containerIdentity]),
          `delete sandbox session container "${containerName}"`,
        );
      },
      async onSessionStop() {
        await stopDockerContainerIfRunning(cli, containerIdentity);
      },
      async onRuntimeShutdown() {
        await stopDockerContainerIfRunning(cli, containerIdentity);
      },
    };
  }

  return {
    async prepare(context) {
      context.log?.("checking Docker daemon");
      await ensureDaemon();
      const dockerfile = await materializeSandboxDockerfile({
        files: context.files,
        storagePath: context.storagePath,
      });
      const templateKey = createSandboxProviderIdentity({
        dockerfile: dockerfile?.contentHash,
        optionsHash,
        resources: sandboxProviderResourceIdentity(context.resources),
        sourceRevision: context.sourceRevision,
        version: 2,
      }).slice(0, 24);
      const templateReferenceInput = { optionsHash, templateKey };
      const imageReference = dockerTemplateImageReference(templateReferenceInput);
      const resourceSource = context.resources.source;
      const resourcesPath =
        resourceSource.kind === "materialized"
          ? await prepareImmutableResources({
              storagePath: context.storagePath,
              provider: DOCKER_PROVIDER_NAME,
              resourcesKey: resourceSource.key,
              sourcePath: resourceSource.path,
            })
          : undefined;
      const markerPath = resolveDockerTemplateMarkerPath(
        context.storagePath,
        templateReferenceInput,
      );

      context.log?.(`checking cached template image "${imageReference}"`);
      if (await dockerImageExists(cli, imageReference)) {
        context.log?.("reusing cached template image");
        await touchDockerTemplateMarker(markerPath, imageReference);
        return { imageReference };
      }

      let baseImage = options.image;
      if (dockerfile === undefined) {
        context.log?.(`checking base image "${options.image}"`);
        await ensureDockerBaseImage(cli, options);
      } else {
        baseImage = dockerfileImageReference({
          dockerfile,
          templateKey,
        });
        context.log?.(`building sandbox Dockerfile "${dockerfile.path}"`);
        await buildSandboxDockerfile({
          cli,
          dockerfile,
          imageReference: baseImage,
        });
      }

      const buildContainerName = `${templateKey}-build-${randomUUID().slice(0, 8)}`;
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
        const templateSession = buildSandboxSession(
          createDockerInternalSession({
            cli,
            containerIdentity: buildContainerIdentity,
          }),
          (policy) => setDockerNetworkPolicy(cli, buildContainerIdentity, policy),
        );

        await hydrateSandboxProviderResources({
          copySkills: true,
          log: context.log,
          resources: context.resources,
          session: templateSession,
        });

        if (authoredOptions.prepare !== undefined) {
          context.log?.("running sandbox preparation");
          await authoredOptions.prepare(
            createLoggingSandboxSession({ log: context.log, session: templateSession }),
          );
        }

        // Quiesce before commit so the captured filesystem is stable.
        context.log?.("stopping template build container");
        expectDockerSuccess(
          await cli.run(["stop", "-t", "0", buildContainerIdentity]),
          `stop template build container "${buildContainerName}"`,
        );
        context.log?.(`committing template image "${imageReference}"`);
        const commit = await cli.run([
          "commit",
          "--change",
          `LABEL ${DOCKER_SANDBOX_LABEL}=1`,
          "--change",
          `LABEL ${DOCKER_SANDBOX_LABEL}.role=template`,
          "--change",
          `LABEL ${DOCKER_SANDBOX_LABEL}.template-key=${templateKey}`,
          buildContainerIdentity,
          imageReference,
        ]);
        if (commit.exitCode !== 0) {
          // Template image tags are daemon-scoped while preparation locks are
          // app-scoped. Concurrent apps can therefore both observe a missing
          // image; accept only the loser of that exact publication race.
          const publishedByPeer =
            /already(?:\s*|-)?exists/iu.test(`${commit.stderr}\n${commit.stdout}`) &&
            (await dockerImageExists(cli, imageReference));
          if (!publishedByPeer) {
            expectDockerSuccess(commit, `commit sandbox template image "${imageReference}"`);
          }
          context.log?.("reusing concurrently published template image");
        }
        await touchDockerTemplateMarker(markerPath, imageReference);
      } finally {
        await cli.run(["rm", "-f", buildContainerName]).catch(() => {});
      }

      return { imageReference };
    },
    async resume(context, artifactValue, stateValue) {
      const state = requireDockerSessionState(stateValue);
      if (state.generation !== dockerGeneration(artifactValue, optionsHash)) {
        throw new Error("Docker sandbox session state is incompatible with this environment.");
      }
      return await openDockerSession(context, undefined, artifactValue, state.containerName, false);
    },
    async start(context, openOptions, artifactValue) {
      const containerName = dockerSessionName(
        context.session.id,
        openOptions,
        artifactValue,
        optionsHash,
      );
      return {
        handle: await openDockerSession(context, openOptions, artifactValue, containerName, true),
        state: {
          containerName,
          generation: dockerGeneration(artifactValue, optionsHash),
          version: 2,
        },
      };
    },
  };
}

function dockerGeneration(artifact: SandboxPreparedArtifact, optionsHash: string): string {
  return createSandboxProviderIdentity({ artifact, environment: optionsHash, version: 1 });
}

function dockerSessionName(
  sessionId: string,
  options: Readonly<DockerSandboxRuntimeOptions> | undefined,
  artifact: SandboxPreparedArtifact,
  optionsHash: string,
): string {
  return `eve-sbx-${createSandboxProviderIdentity({
    artifact,
    environment: optionsHash,
    open: { networkPolicy: options?.networkPolicy },
    sessionId,
    version: 1,
  }).slice(0, 32)}`;
}

function requirePreparedDockerArtifact(
  artifact: SandboxPreparedArtifact,
): DockerSandboxPreparedArtifact {
  if (!isSandboxPreparedArtifactRecord(artifact) || typeof artifact.imageReference !== "string") {
    throw new Error("Invalid prepared Docker artifact.");
  }
  return { imageReference: artifact.imageReference };
}

function requireDockerSessionState(state: SandboxPreparedArtifact): DockerSandboxSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 2 ||
    typeof state.containerName !== "string" ||
    typeof state.generation !== "string"
  ) {
    throw new Error("Invalid Docker sandbox session state.");
  }
  return { containerName: state.containerName, generation: state.generation, version: 2 };
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
