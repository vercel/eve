import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

/** A successful start may return before its workflow has claimed the receiving hook. */
export async function awaitInboxClaim<T>(send: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  let delay = 25;
  while (true) {
    try {
      return await send();
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
