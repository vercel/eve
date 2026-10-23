/**
 * The review page carries the unsent report in the URL hash. Analytics and
 * Speed Insights report the full URL, so drop the hash on that page before any
 * beacon leaves the browser.
 */
export const withoutReportHash = <Event extends { url: string }>(event: Event): Event => {
  try {
    const url = new URL(event.url);
    if (!/^(?:\/[a-z]{2})?\/agent-feedback\/?$/.test(url.pathname) || !url.hash) return event;
    url.hash = "";
    return { ...event, url: url.toString() };
  } catch {
    return event;
  }
};
