import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { isVercelSandboxMissingError } from "#execution/sandbox/bindings/vercel-errors.js";
import { errorMessage } from "#execution/sandbox/bindings/vercel-options.js";
import type {
  VercelCreateOptions,
  VercelGetOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export async function getNamedVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly sandboxName: string;
}): Promise<VercelSandbox | null> {
  try {
    return await input.sandboxModule.Sandbox.get(await getVercelSandboxGetOptions(input));
  } catch (error) {
    if (isVercelSandboxMissingError(error)) {
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
  const baseOptions = {
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandboxName,
    resume: false,
  };

  try {
    const credentials = await getVercelSandboxCredentials(input.createOptions);
    return {
      ...baseOptions,
      ...credentials,
      signal: input.createOptions.signal,
    };
  } catch {
    return baseOptions;
  }
}
