import { WizardCancelledError } from "#setup/step.js";

export interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRegistryNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "NOT_FOUND"
  );
}

export async function runRegistryAction<T>(
  logger: RegistryCommandLogger,
  _appRoot: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WizardCancelledError) return undefined;
    logger.error(errorMessage(error));
    process.exitCode = 1;
    return undefined;
  }
}

export async function resolveRegistryItemForAdd<T>(
  logger: RegistryCommandLogger,
  loadItem: () => Promise<T>,
  printSuggestions: () => Promise<void>,
): Promise<{ found: true; item: T } | { found: false }> {
  try {
    return { found: true, item: await loadItem() };
  } catch (error) {
    if (!isRegistryNotFoundError(error)) throw error;
    logger.error(errorMessage(error));
    await printSuggestions();
    process.exitCode = 1;
    return { found: false };
  }
}

export function setupResumeCommand(item: string): string {
  const argument = /^[\w@./:-]+$/.test(item) ? item : `'${item.replaceAll("'", `'\\''`)}'`;
  return `eve add ${argument} --skip-install`;
}

export function setupReminder(item: string, outcome: "cancelled" | "skipped"): string {
  const action = outcome === "cancelled" ? "Setup cancelled." : "Setup skipped.";
  return `${action} Run \`${setupResumeCommand(item)}\` when you're ready.`;
}
