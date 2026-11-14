// @linux-only: host battery, World host side
import { describeSessionHost } from "./battery.js";
import { worldHost } from "./host-under-test.js";

describeSessionHost("world", worldHost);
