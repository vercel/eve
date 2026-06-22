import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type {
  VercelSdkCreateOptions,
  VercelSdkGetOptions,
  VercelSdkModule,
  VercelSdkSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export async function getNamedVercelSandbox(input: {
  readonly createOptions: VercelSdkCreateOptions;
  readonly sandboxModule: VercelSdkModule;
  readonly sandboxName: string;
}): Promise<VercelSdkSandbox | null> {
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
  readonly createOptions: VercelSdkCreateOptions;
  readonly sandboxName: string;
}): Promise<VercelSdkGetOptions> {
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
    } as VercelSdkGetOptions;
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
