import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "Repeated model-free schedule dispatches settle their registered background work.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) t.skip("Schedule dispatch requires development routes.");
    const readCompleted = async () => {
      const response = await t.target.fetch("/schedule-lifecycle");
      await t.require(response.status, equals(200));
      return ((await response.json()) as { completed: number }).completed;
    };
    const initial = await readCompleted();
    for (let index = 1; index <= 2; index++) {
      const dispatch = await t.target.dispatchSchedule("lifecycle");
      await t.require(dispatch.scheduleId, equals("lifecycle"));
      await t.require(dispatch.sessionIds.length, equals(0));
      await t.require(await readCompleted(), equals(initial + index));
    }
  },
});
