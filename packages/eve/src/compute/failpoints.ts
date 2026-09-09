export type ComputeFailpointName =
  | "admission.before_commit"
  | "admission.after_commit"
  | "transition.before_commit"
  | "transition.after_commit";

export interface ComputeFailpoints {
  hit(name: ComputeFailpointName): Promise<void>;
}

export const NO_COMPUTE_FAILPOINTS: ComputeFailpoints = {
  async hit(): Promise<void> {},
};
