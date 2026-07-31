import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type {
  VercelGetOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-options.js";

export async function getNamedVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly sandboxName: string;
}): Promise<VercelSandbox | null> {
  try {
    return await input.sandboxModule.Sandbox.get(await getVercelSandboxGetOptions(input));
  } catch (error) {
    if (isSandboxMissingError(error)) {
      return null;
    }

    throw new Error(
      `Failed to look up Vercel sandbox "${input.sandboxName}": ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function getVercelSandboxGetOptions(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxName: string;
}): Promise<VercelGetOptions> {
  const baseOptions: VercelGetOptions = {
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandboxName,
    resume: false,
    signal: input.createOptions.signal,
  };

  try {
    const credentials = await getVercelSandboxCredentials(input.createOptions);
    return { ...baseOptions, ...credentials };
  } catch {
    return baseOptions;
  }
}

function isSandboxMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = readResponseStatus(error) ?? readResponseStatus(error.cause);

  return status === 404;
}

function readResponseStatus(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || !("response" in value)) {
    return undefined;
  }
  const response = value.response;
  if (response === null || typeof response !== "object" || !("status" in response)) {
    return undefined;
  }
  return typeof response.status === "number" ? response.status : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseJson = "json" in error ? error.json : undefined;
    const responseText = "text" in error ? error.text : undefined;
    const responseBody =
      typeof responseText === "string" && responseText.length > 0
        ? responseText
        : responseJson !== undefined
          ? JSON.stringify(responseJson)
          : undefined;
    if (responseBody !== undefined) {
      return `${error.message}: ${responseBody}`;
    }
    return error.message;
  }
  return String(error);
}
