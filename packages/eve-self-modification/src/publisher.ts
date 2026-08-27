import type {
  PreparedSelfModificationWorkspace,
  SelfModificationCommandSandbox,
} from "./git-workspace.js";

/** Provider-neutral metadata and trusted workspace for one publication operation. */
export interface SelfModificationPublicationRequest {
  readonly deployedSha: string;
  readonly description: string;
  readonly operationId: string;
  readonly sandbox: SelfModificationCommandSandbox;
  readonly title: string;
  readonly workspace: PreparedSelfModificationWorkspace;
}

export interface SelfModificationPublicationReceipt {
  readonly changedPaths: readonly string[];
  readonly commitSha: string;
  readonly deployedSha: string;
  readonly targetBranch: string;
}

/** A trusted destination for a complete self-modification proposal. */
export interface SelfModificationProposalPublisher<
  Receipt extends SelfModificationPublicationReceipt = SelfModificationPublicationReceipt,
> {
  publish(input: SelfModificationPublicationRequest): Promise<Receipt>;
}

/** Publishes through the destination selected by trusted application configuration. */
export async function publishSelfModification<
  Receipt extends SelfModificationPublicationReceipt,
>(input: {
  readonly publisher: SelfModificationProposalPublisher<Receipt>;
  readonly request: SelfModificationPublicationRequest;
}): Promise<Receipt> {
  return await input.publisher.publish(input.request);
}
