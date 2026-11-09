/** Ready response from the workflow health endpoint. */
export interface HealthResult {
  ok: true;
  status: "ready";
  workflowId: string;
}
