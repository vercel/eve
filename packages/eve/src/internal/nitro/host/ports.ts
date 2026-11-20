export const DEFAULT_DEVELOPMENT_SERVER_PORT = 2000;

export const MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS = 10;

const MAX_ALLOWED_DEVELOPMENT_SERVER_PORT = 65_535;
const PORT_ENV = "PORT";

export function readDevelopmentServerEnvironmentPort(): number | undefined {
  const raw = process.env[PORT_ENV];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  if (!isAllowedPort(parsed)) {
    throw new Error(
      `Invalid ${PORT_ENV} environment variable "${raw}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return parsed;
}

export function resolveDevelopmentServerPorts(input: {
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}): readonly [number, ...number[]] {
  const port =
    typeof input.port === "string"
      ? Number(input.port)
      : (input.port ?? DEFAULT_DEVELOPMENT_SERVER_PORT);

  if (!isAllowedPort(port)) {
    throw new Error(
      `Invalid development server port "${String(input.port)}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  if (port === 0 || !input.retryOnAddressInUse) {
    return [port];
  }

  const ports: [number, ...number[]] = [port];
  for (
    let candidate = port + 1;
    candidate < port + MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS &&
    candidate <= MAX_ALLOWED_DEVELOPMENT_SERVER_PORT;
    candidate += 1
  ) {
    ports.push(candidate);
  }
  return ports;
}

function isAllowedPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= MAX_ALLOWED_DEVELOPMENT_SERVER_PORT;
}
