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
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-backend-utils.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "#public/definitions/sandbox-backend.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";

export {
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker-templates.js";

/**
 * Stable backend name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const DOCKER_BACKEND_NAME = "docker";

/**
 * Construction input for {@link createDockerSandboxBackend}. Internal —
 * the public surface is the `docker()` factory under
 * `eve/sandbox`.
 */
export interface CreateDockerSandboxBackendInput {
  readonly createOptions?: DockerSandboxCreateOptions;
  /** Injectable Docker driver so backend logic is testable without a daemon. */
  readonly dockerCli?: DockerCli;
}

/**
 * Creates the Docker sandbox backend.
 *
 * Two-phase lifecycle mapped onto Docker primitives:
 *
 * - `prewarm` runs the base image, applies base setup, runs the
 *   authored `bootstrap`, writes seed files, then `docker commit`s the
 *   container into a reusable template image.
 * - `create` starts (or restarts) one long-lived container per session
 *   key from the template image. The container's filesystem carries
 *   session state across reconnects, so `shutdown` only stops the
 *   container and the next `create` restarts it with state intact.
 */
export function createDockerSandboxBackend(
  input: CreateDockerSandboxBackendInput = {},
): SandboxBackend {
  const cli = input.dockerCli ?? createDockerCli();
  const options = resolveDockerSandboxOptions(input.createOptions);
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
    name: DOCKER_BACKEND_NAME,
    async prewarm(prewarmInput: SandboxBackendPrewarmInput): Promise<SandboxBackendPrewarmResult> {
      prewarmInput.log?.("checking Docker daemon");
      await ensureDaemon();
      const templateReferenceInput = {
        optionsHash,
        templateKey: prewarmInput.templateKey,
      };
      const imageReference = dockerTemplateImageReference(templateReferenceInput);
      const markerPath = resolveDockerTemplateMarkerPath(
        prewarmInput.runtimeContext.appRoot,
        templateReferenceInput,
      );

      prewarmInput.log?.(`checking cached template image "${imageReference}"`);
      if (await dockerImageExists(cli, imageReference)) {
        prewarmInput.log?.("reusing cached template image");
        await touchDockerTemplateMarker(markerPath, imageReference);
        return { reused: true };
      }

      prewarmInput.log?.(`checking base image "${options.image}"`);
      await ensureDockerBaseImage(cli, options);

      const buildContainerName = `${prewarmInput.templateKey}-build-${randomUUID().slice(0, 8)}`;
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
            id: prewarmInput.templateKey,
          }),
          (policy) => setDockerNetworkPolicy(cli, buildContainerName, policy),
        );

        if (prewarmInput.bootstrap !== undefined) {
          prewarmInput.log?.("running sandbox bootstrap");
          await prewarmInput.bootstrap({
            use: async () =>
              createLoggingSandboxSession({
                log: prewarmInput.log,
                session: templateSession,
              }),
          });
        }

        if (prewarmInput.seedFiles.length > 0) {
          prewarmInput.log?.(`writing ${prewarmInput.seedFiles.length} seed file(s)`);
        }
        await writeSandboxSeedFiles(templateSession, prewarmInput.seedFiles);

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
            `LABEL ${DOCKER_SANDBOX_LABEL}.template-key=${prewarmInput.templateKey}`,
            buildContainerName,
            imageReference,
          ]),
          `commit sandbox template image "${imageReference}"`,
        );
        await touchDockerTemplateMarker(markerPath, imageReference);
      } finally {
        await cli.run(["rm", "-f", buildContainerName]).catch(() => {});
      }

      return { reused: false };
    },
    async create(createInput: SandboxBackendCreateInput): Promise<SandboxBackendHandle> {
      await ensureDaemon();
      const containerName =
        getDockerContainerName(createInput.existingMetadata) ?? createInput.sessionKey;

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
        if (createInput.templateKey === null) {
          await ensureDockerBaseImage(cli, options);
          image = options.image;
        } else {
          const templateReferenceInput = {
            optionsHash,
            templateKey: createInput.templateKey,
          };
          image = dockerTemplateImageReference(templateReferenceInput);
          if (!(await dockerImageExists(cli, image))) {
            throw new SandboxTemplateNotProvisionedError({
              backendName: DOCKER_BACKEND_NAME,
              templateKey: createInput.templateKey,
            });
          }
          await touchDockerTemplateMarker(
            resolveDockerTemplateMarkerPath(
              createInput.runtimeContext.appRoot,
              templateReferenceInput,
            ),
            image,
          );
        }

        try {
          await startDockerContainer({
            cli,
            containerName,
            image,
            initialNetworkPolicy:
              createInput.templateKey === null ? "allow-all" : options.networkPolicy,
            options,
            role: "session",
            tags: createInput.tags,
          });
        } catch (error) {
          if (createInput.templateKey !== null) {
            throw new SandboxTemplateNotProvisionedError({
              backendName: DOCKER_BACKEND_NAME,
              templateKey: createInput.templateKey,
            });
          }
          throw error;
        }

        if (createInput.templateKey === null) {
          await runDockerBaseSetup(cli, containerName);
          if (options.networkPolicy !== "allow-all") {
            await setDockerNetworkPolicy(cli, containerName, options.networkPolicy);
          }
        }
      }

      const session = buildSandboxSession(
        createDockerInternalSession({ cli, containerName, id: createInput.sessionKey }),
        (policy) => setDockerNetworkPolicy(cli, containerName, policy),
      );

      return {
        session,
        useSessionFn: async () => session,
        async captureState() {
          return {
            backendName: DOCKER_BACKEND_NAME,
            metadata: { containerName },
            sessionKey: createInput.sessionKey,
          };
        },
        // Session state lives in the container filesystem, so a stopped
        // container restarts with state intact on the next `create`.
        async shutdown() {
          await stopDockerContainerIfRunning(cli, containerName);
        },
      };
    },
  };
}

function getDockerContainerName(metadata: Record<string, unknown> | undefined): string | undefined {
  const containerName = metadata?.containerName;
  return typeof containerName === "string" ? containerName : undefined;
}
