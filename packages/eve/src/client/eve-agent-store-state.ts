import type { MessageResponse } from "#client/message-response.js";
import type { CancelSessionResult } from "#client/types.js";

export interface PendingMessageSubmission {
  readonly createdAt: number;
  readonly id: string;
  readonly message: string;
}

export interface ActiveTurn {
  readonly abortController: AbortController;
  acceptedFollowUps: number;
  readonly cancel: () => Promise<CancelSessionResult>;
  readonly completion: Promise<void>;
  readonly followUpDispatches: Set<Promise<void>>;
  receivedFollowUps: number;
  readonly followUpSubmissionIds: Set<string>;
  readonly resolveCompletion: () => void;
  readonly response: Promise<MessageResponse | undefined>;
  readonly resolveResponse: (response: MessageResponse | undefined) => void;
}
