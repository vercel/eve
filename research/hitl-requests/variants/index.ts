import type { VariantRegistry } from "../types.js";
import { approval } from "./approval.js";
import { challenge } from "./challenge.js";
import { limit } from "./limit.js";
import { question } from "./question.js";

export type {
  ApprovalOutcome,
  ApprovalPolicyResult,
  ApprovalResponsePolicy,
  ApprovalSpec,
} from "./approval.js";
export type { ChallengeOutcome, ChallengeSpec } from "./challenge.js";
export type { LimitOutcome, LimitSpec } from "./limit.js";
export type { QuestionOutcome, QuestionSpec } from "./question.js";

export const variants: VariantRegistry = { approval, question, limit, challenge };
