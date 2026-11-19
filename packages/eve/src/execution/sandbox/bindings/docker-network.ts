import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

export function assertDockerNetworkPolicy(
  policy: SandboxNetworkPolicy,
): asserts policy is "allow-all" | "deny-all" {
  if (policy !== "allow-all" && policy !== "deny-all") {
    throw new Error(
      'The local Docker sandbox provider supports only the "allow-all" and "deny-all" network ' +
        "policies. Domain-level allow-lists and credential brokering require the Vercel provider " +
        "(VercelSandbox).",
    );
  }
}

export async function setDockerNetworkPolicy(
  cli: DockerCli,
  containerName: string,
  policy: SandboxNetworkPolicy,
): Promise<void> {
  assertDockerNetworkPolicy(policy);

  const inspect = await cli.run([
    "container",
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    containerName,
  ]);
  expectDockerSuccess(inspect, `inspect networks of sandbox container "${containerName}"`);
  const networkSettings: unknown = JSON.parse(inspect.stdout.trim() === "" ? "{}" : inspect.stdout);
  if (typeof networkSettings !== "object" || networkSettings === null) {
    throw new Error(`Docker returned invalid network settings for "${containerName}".`);
  }
  const networks = Object.keys(networkSettings);

  if (policy === "deny-all") {
    for (const network of networks) {
      expectDockerSuccess(
        await cli.run(["network", "disconnect", "--force", network, containerName]),
        `disconnect sandbox container "${containerName}" from network "${network}"`,
      );
    }
    return;
  }

  if (!networks.includes("bridge")) {
    if (networks.includes("none")) {
      expectDockerSuccess(
        await cli.run(["network", "disconnect", "--force", "none", containerName]),
        `detach sandbox container "${containerName}" from the none network`,
      );
    }
    expectDockerSuccess(
      await cli.run(["network", "connect", "bridge", containerName]),
      `connect sandbox container "${containerName}" to the bridge network`,
    );
  }
}
