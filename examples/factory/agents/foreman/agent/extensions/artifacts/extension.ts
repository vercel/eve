/**
 * Consumes handoff artifacts by id; never produces one. The saver is
 * disabled beside this mount, which is what keeps long documents flowing
 * station-to-station instead of through this agent's output.
 */
export { default } from "@factory/artifacts";
