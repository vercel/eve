const VERCEL_SERVICE_NAME_PATTERN = /^[a-z](?:[a-z_-]*[a-z])?$/;

/** Maximum service-name length accepted by Vercel Services. */
export const MAX_VERCEL_SERVICE_NAME_LENGTH = 64;

/** Whether a name satisfies the Vercel Services naming contract. */
export function isValidVercelServiceName(name: string): boolean {
  return name.length <= MAX_VERCEL_SERVICE_NAME_LENGTH && VERCEL_SERVICE_NAME_PATTERN.test(name);
}

/** Assert that a generated or authored service name can be deployed to Vercel. */
export function assertValidVercelServiceName(name: string, subject: string): void {
  if (isValidVercelServiceName(name)) return;
  throw new Error(
    `${subject} ${JSON.stringify(name)} is invalid. Vercel service names must use 1-${MAX_VERCEL_SERVICE_NAME_LENGTH} lowercase letters, hyphens, or underscores, beginning and ending with a letter.`,
  );
}
