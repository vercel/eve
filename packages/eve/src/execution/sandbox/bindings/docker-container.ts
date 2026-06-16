import { buildDockerBaseSetupScript } from "#execution/sandbox/bindings/docker-base-setup.js";
import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import type { ResolvedDockerSandboxOptions } from "#execution/sandbox/bindings/docker-options.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { withDevelopmentSandboxTags } from "#execution/sandbox/development-run.js";
import type { SandboxBackendTags } from "#public/definitions/sandbox-backend.js";
import type { DockerSandboxNetworkPolicy } from "#public/sandbox/docker-sandbox.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export const DOCKER_SANDBOX_LABEL = "eve.sandbox";

// PID 1 must outlive every exec'd command; the largest portable sleep
// argument keeps the container alive without depending on GNU
// `sleep infinity` being present in the image.
const DOCKER_KEEPALIVE_ARGS = ["-c", "sleep 2147483647"] as const;

export async function startDockerContainer(input: {
  readonly cli: DockerCli;
  readonly containerName: string;
  readonly image: string;
  readonly initialNetworkPolicy: DockerSandboxNetworkPolicy;
  readonly options: ResolvedDockerSandboxOptions;
  readonly role: "session" | "template-build";
  readonly tags?: SandboxBackendTags;
}): Promise<void> {
  const args = [
    "run",
    "-d",
    "--name",
    input.containerName,
    "--label",
    `${DOCKER_SANDBOX_LABEL}=1`,
    "--label",
    `${DOCKER_SANDBOX_LABEL}.role=${input.role}`,
  ];

  for (const [key, value] of Object.entries(withDevelopmentSandboxTags(input.tags) ?? {})) {
    args.push("--label", `${DOCKER_SANDBOX_LABEL}.tag.${key}=${value}`);
  }
  for (const [key, value] of Object.entries(input.options.env)) {
    args.push("-e", `${key}=${value}`);
  }
  if (input.initialNetworkPolicy === "deny-all") {
    args.push("--network", "none");
  }

  args.push(
    "--workdir",
    WORKSPACE_ROOT,
    "--entrypoint",
    "/bin/sh",
    input.image,
    ...DOCKER_KEEPALIVE_ARGS,
  );

  expectDockerSuccess(
    await input.cli.run(args),
    `start sandbox container "${input.containerName}" from "${input.image}"`,
  );
}

export async function runDockerBaseSetup(cli: DockerCli, containerName: string): Promise<void> {
  expectDockerSuccess(
    await cli.run([
      "exec",
      "--user",
      "root",
      containerName,
      "/bin/sh",
      "-c",
      buildDockerBaseSetupScript(),
    ]),
    `prepare base runtime in sandbox container "${containerName}"`,
  );
}

export async function stopDockerContainerIfRunning(
  cli: DockerCli,
  containerName: string,
): Promise<void> {
  await cli.run(["stop", "-t", "0", containerName]).catch(() => {});
}
