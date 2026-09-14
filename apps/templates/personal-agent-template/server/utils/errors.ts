import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";

export function throwConnectError(error: unknown): never {
  if (error instanceof UserAuthorizationRequiredError) {
    throw createError({
      statusCode: 409,
      statusMessage: "Authorization required",
      message: "Connect this integration before running a test.",
    });
  }

  if (error instanceof ConnectorInstallationRequiredError) {
    throw createError({
      statusCode: 409,
      statusMessage: "Installation required",
      message: "Install this integration before running a test.",
    });
  }

  if (error instanceof NoValidTokenError) {
    throw createError({
      statusCode: 409,
      statusMessage: "Not connected",
      message: "No valid token is available. Connect again to continue.",
    });
  }

  if (error instanceof ConnectError) {
    throw createError({
      statusCode: 502,
      statusMessage: "Connect error",
      message: error.message,
    });
  }

  throw createError({
    statusCode: 502,
    statusMessage: "Request failed",
    message: error instanceof Error ? error.message : "Unknown error",
  });
}
