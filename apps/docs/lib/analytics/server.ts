import { track } from "@vercel/analytics/server";
import { type AnalyticsEventName, getAnalyticsUrl } from "./events";

export const trackServerEvent = (
  request: Request,
  event: AnalyticsEventName,
  properties: Record<string, boolean | number | string>,
) => {
  const analyticsUrl = getAnalyticsUrl(request.url);
  if (!analyticsUrl) return;

  const analyticsRequest = new Request(analyticsUrl, {
    headers: request.headers,
    method: request.method,
  });
  void track(event, properties, { request: analyticsRequest });
};
