/**
 * Calls `check` until it returns a value, backing off from 20 ms to 200 ms
 * between calls, and resolves `undefined` once `timeoutMs` passes without one.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (let delayMs = 20; ; delayMs = Math.min(delayMs * 2, 200)) {
    const value = await check();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
