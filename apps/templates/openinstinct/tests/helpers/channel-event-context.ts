/**
 * The `waitUntil` of a channel event context, for tests that call a handler directly. The task
 * keeps running, so an unexpected rejection still fails the test. Spread it into the fixture
 * instead of writing it inline, so the fixture type-checks against eve versions both before and
 * after `waitUntil` joined the event context.
 */
export const backgroundWork = {
  waitUntil(task: Promise<unknown>): void {
    void task;
  },
};
