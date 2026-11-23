import { defineSchedule } from "eve/schedules";
import extension from "../extension.js";

export default defineSchedule({
  cron: extension.config.cron,
  content:
    "Call the installed self-improvement extension's cycle tool exactly once. If it returns status delegated, call the coordinator tool by the exact name returned, then report that coordinator's actual final status. The cycle checks the real runtime app identity and schedule; request it instead of guessing authorization from this message. Do not publish through other tools.",
});
