import { defineChannel, GET } from "eve/channels";

import { lifecycleState } from "../lib/lifecycle-state";

export default defineChannel({
  routes: [GET("/schedule-lifecycle", async () => Response.json(lifecycleState))],
});
