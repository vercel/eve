import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { parseJsonObject } from "#shared/json.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

/**
 * Applies a coarse-grained run-time network policy by attaching or
 * detaching the container's networks. Domain-level policies and
 * credential brokering require the firewall on the Vercel provider.
 */
export async function setDockerNetworkPolicy(
  cli: DockerCli,
  containerName: string,
  policy: SandboxNetworkPolicy,
): Promise<void> {
  if (policy !== "allow-all" && policy !== "deny-all") {
    throw new Error(
      'The local Docker sandbox provider supports only the "allow-all" and "deny-all" network ' +
        "policies. Domain-level allow-lists and credential brokering require the Vercel provider " +
        "(VercelSandbox) or MicrosandboxSandbox.",
    );
  }

  const inspect = await cli.run([
    "container",
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    containerName,
  ]);
  expectDockerSuccess(inspect, `inspect networks of sandbox container "${containerName}"`);
  const networks = Object.keys(
    parseJsonObject(JSON.parse(inspect.stdout.trim() === "" ? "{}" : inspect.stdout)),
  );

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
    // A container created with `--network none` sits on the special
    // "none" network, which Docker refuses to combine with any other
    // network ("container cannot be connected to multiple networks
    // with one of the networks in private (none) mode") — detach it
    // before attaching the bridge.
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
