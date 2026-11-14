// @linux-only: host battery, in-process side, on a World restarted at every rest
import { describeSessionHost } from "./battery.js";
import { inProcessWorldRestartHost } from "./host-under-test.js";

describeSessionHost("in-process-world-restart", inProcessWorldRestartHost);
