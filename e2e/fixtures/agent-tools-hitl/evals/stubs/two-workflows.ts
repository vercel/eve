import { defineToolStubs } from "eve/evals";

export default defineToolStubs({
  state: () => ({
    schedules: [{ id: "sched_1", name: "Weekly commit activity" }],
  }),
  tools: {
    schedules_read: (_input, { state }) => ({ schedules: state.schedules }),
    schedules_create: (input: { name: string }, { state }) => {
      const schedule = { id: `sched_${state.schedules.length + 1}`, name: input.name };
      state.schedules.push(schedule);
      return { schedule };
    },
  },
});
