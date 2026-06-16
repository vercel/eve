import type {
  SandboxCreateOptions,
  SandboxGetOptions,
  Sandbox as SdkSandbox,
} from "#compiled/@vercel/sandbox/index.js";

import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type { VercelSandboxModule } from "#execution/sandbox/bindings/vercel-create-sdk.js";

export async function getNamedVercelSandbox(input: {
  readonly createOptions: SandboxCreateOptions;
  readonly sandboxModule: VercelSandboxModule;
  readonly sandboxName: string;
}): Promise<SdkSandbox | null> {
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
  readonly createOptions: SandboxCreateOptions;
  readonly sandboxName: string;
}): Promise<SandboxGetOptions> {
  const baseOptions = {
    name: input.sandboxName,
    resume: false,
  };

  try {
    const credentials = await getVercelSandboxCredentials(input.createOptions);
    return {
      ...baseOptions,
      ...credentials,
      fetch: getVercelSandboxFetch(input.createOptions),
      signal: input.createOptions.signal,
    } as SandboxGetOptions;
  } catch {
    return baseOptions;
  }
}

function isSandboxMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const status =
    (error as { response?: { status?: number } }).response?.status ??
    (error as { cause?: { response?: { status?: number } } }).cause?.response?.status;

  return status === 404;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseJson = (error as { readonly json?: unknown }).json;
    const responseText = (error as { readonly text?: unknown }).text;
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
