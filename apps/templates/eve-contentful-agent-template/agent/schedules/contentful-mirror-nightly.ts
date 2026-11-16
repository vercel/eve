import { defineSchedule } from "eve/schedules";

import { runScheduledMirrorSync } from "../lib/contentful/mirror/drive";

/**
 * Refresh the searchable copy of Contentful content daily and remove deleted entries.
 */
export default defineSchedule({
  cron: "30 16 * * *",
  run({ waitUntil }) {
    waitUntil(runScheduledMirrorSync("full"));
  },
});
