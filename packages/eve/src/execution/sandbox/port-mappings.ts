import type { SandboxPortMapping } from "#shared/sandbox-session.js";

const MIN_PORT = 1;
const MAX_PORT = 65_535;

export function normalizeSandboxPortMappings(
  mappings: ReadonlyArray<SandboxPortMapping> | undefined,
): ReadonlyArray<SandboxPortMapping> {
  const resolved = mappings?.map((mapping) => ({ ...mapping })) ?? [];
  const hostPorts = new Set<number>();
  const sandboxPorts = new Set<number>();

  for (const mapping of resolved) {
    validatePort(mapping.hostPort, "hostPort");
    validatePort(mapping.sandboxPort, "sandboxPort");
    if (hostPorts.has(mapping.hostPort)) {
      throw new Error(`Duplicate sandbox hostPort: ${String(mapping.hostPort)}.`);
    }
    if (sandboxPorts.has(mapping.sandboxPort)) {
      throw new Error(`Duplicate sandboxPort: ${String(mapping.sandboxPort)}.`);
    }
    hostPorts.add(mapping.hostPort);
    sandboxPorts.add(mapping.sandboxPort);
  }

  return resolved;
}

export function getLoopbackPortUrl(
  mappings: ReadonlyArray<SandboxPortMapping>,
  sandboxPort: number,
): string {
  const mapping = mappings.find((entry) => entry.sandboxPort === sandboxPort);
  if (mapping === undefined) {
    throw new Error(`Sandbox port ${String(sandboxPort)} is not published.`);
  }
  return `http://127.0.0.1:${String(mapping.hostPort)}`;
}

function validatePort(port: number, name: string): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
}
