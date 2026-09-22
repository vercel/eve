import { evaluate } from "eve/ai";
import { defineInstrumentation } from "eve/instrumentation";

import { classificationProbe } from "../testing";

type Sensitivity = "ordinary" | "restricted";

const JEV_PROBE = "jev-classification";

export default defineInstrumentation<Sensitivity>({
  async classificationPolicy(input, { abortSignal }) {
    if (
      input.boundary === "trace" ||
      input.record.type !== "channel.delivery.started" ||
      !JSON.stringify(input.record.input).includes(JEV_PROBE)
    ) {
      return "ordinary";
    }

    const result = await evaluate({
      model: "typesafe-ai/jev",
      state: {
        expected: "restricted",
        workflow: "Alice is classifying a restricted support record.",
      },
      questions: {
        sensitivity: {
          type: "choice",
          instructions: "Select the option whose key exactly matches state.expected.",
          criteria: {
            ordinary: "The expected classification is ordinary.",
            restricted: "The expected classification is restricted.",
          },
        },
      },
      abortSignal,
      maxRetries: 0,
    });
    const classification = result.answers.sensitivity.choice;
    classificationProbe.update((value) => ({
      ...value,
      requests: value.requests + 1,
      result: classification,
    }));
    return classification;
  },

  events: {
    "channel.delivery.started"(_event, { classification }) {
      classificationProbe.update((value) => ({
        ...value,
        observed: classification ?? "missing",
      }));
    },
  },

  tracePolicy: () => ({
    emit: true,
    recordInputs: true,
    recordOutputs: true,
  }),
});
