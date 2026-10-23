import type { RequestReducerRegistry } from "../types.js";
import { approval } from "./approval.js";
import { authorization } from "./authorization.js";
import { limit } from "./limit.js";
import { question } from "./question.js";

export type {
  ApprovalOutcome,
  ApprovalPolicyResult,
  ApprovalResponsePolicy,
  ApprovalSpec,
} from "./approval.js";
export type { AuthorizationOutcome, AuthorizationSpec } from "./authorization.js";
export type { LimitOutcome, LimitSpec } from "./limit.js";
export type { QuestionOutcome, QuestionSpec } from "./question.js";

export const reducers: RequestReducerRegistry = { approval, question, limit, authorization };
