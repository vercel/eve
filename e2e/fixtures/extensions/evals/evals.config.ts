import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

/** Resource shared by setup, evals, and teardown. */
export class SetupResource {
  #closed = false;

  read() {
    if (this.#closed) throw new Error("Eval setup resource is closed.");
    return "ready";
  }

  close() {
    this.#closed = true;
  }
}

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  setup() {
    return { resource: new SetupResource() };
  },
  teardown(context) {
    context?.resource.close();
  },
});
