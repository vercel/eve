export function isVercelSchedulesDevEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.VERCEL_DEPLOYMENT_ID === undefined &&
    process.env.VERCEL_SCHEDULE_DEV_API_VERSION !== undefined
  );
}
