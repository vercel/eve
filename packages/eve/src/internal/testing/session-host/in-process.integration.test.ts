// @linux-only: host battery, in-process side
import { describeSessionHost } from "./battery.js";
import { inProcessHost } from "./host-under-test.js";

describeSessionHost("in-process", inProcessHost);
