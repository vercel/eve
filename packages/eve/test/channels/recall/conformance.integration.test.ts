import type { ContractRuleName } from "#internal/testing/channel-conformance/contract.js";
import {
  type BrokenCell,
  describeConformance,
} from "#internal/testing/channel-conformance/conformance.js";

import { recallDriver } from "./recall-driver.js";

const RECALL_BROKEN = {
  "a message while a question without free text is pending withdraws it, and the next message gets a reply":
    {
      reason:
        "the queue turn policy holds the message until the turn ends, but the turn is waiting on the question",
      symptom: /Timed out waiting for a reply to/u,
    },
} satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const RECALL_SPEECH_ONE_LINE =
  "transcribed speech arrives as one line, which can't carry the test model's multi-line request for parallel calls";
const RECALL_SPEECH_UNSUPPORTED = {
  "text replies answer two pending approvals one at a time, in the order shown":
    RECALL_SPEECH_ONE_LINE,
  "text replies answer a question and an approval raised together, in the order shown":
    RECALL_SPEECH_ONE_LINE,
} satisfies Partial<Record<ContractRuleName, string>>;

const RECALL_PRIVATE_CHAT =
  "only Zoom's meeting chat reaches one participant, so elsewhere the channel won't post a sign-in link or code everyone would see";
const RECALL_NO_PRIVATE_CHAT = {
  "a sign-in names the service and shows its sign-in link": RECALL_PRIVATE_CHAT,
  "a sign-in shows its confirmation code": RECALL_PRIVATE_CHAT,
} satisfies Partial<Record<ContractRuleName, string>>;

describeConformance([
  { driver: () => recallDriver(), broken: RECALL_BROKEN },
  {
    driver: () => recallDriver({ input: "speech" }),
    broken: RECALL_BROKEN,
    unsupported: RECALL_SPEECH_UNSUPPORTED,
  },
  {
    driver: () => recallDriver({ platform: "google_meet" }),
    broken: RECALL_BROKEN,
    unsupported: RECALL_NO_PRIVATE_CHAT,
  },
]);
