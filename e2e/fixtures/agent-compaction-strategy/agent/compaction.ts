import { defineCompaction } from "eve/compaction";

const KEPT_MESSAGES = 2;

/** Keeps the latest messages, starting at a user message, and writes no summary. */
export default defineCompaction({
  async compact(history) {
    const tail = history.slice(-KEPT_MESSAGES);
    const firstUser = tail.findIndex((message) => message.role === "user");
    return firstUser === -1 ? tail : tail.slice(firstUser);
  },
});
