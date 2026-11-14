import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@db/services/auth";

async function loadHandlers() {
  return toNextJsHandler(await getAuth());
}

let handlersPromise: ReturnType<typeof loadHandlers> | undefined;

function getHandlers() {
  handlersPromise ??= loadHandlersWithRetry();
  return handlersPromise;
}

async function loadHandlersWithRetry() {
  try {
    return await loadHandlers();
  } catch (error) {
    handlersPromise = undefined;
    throw error;
  }
}

export async function GET(request: Request) {
  return (await getHandlers()).GET(request);
}

export async function POST(request: Request) {
  return (await getHandlers()).POST(request);
}
