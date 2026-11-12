import { defineExtension } from "eve/extension";
import type { MemoryDocumentBackend } from "eve/memory/file";
import type { ApprovalResponsePolicy } from "eve/tools/approval";
import { z } from "zod";

import type { SkillRepository } from "./lib/repository.ts";
import type {
  SkillApprovalRule,
  SkillChangeEvent,
  SkillScopeResolver,
  SkillValidator,
} from "./lib/types.ts";

export type {
  SkillApprovalRule,
  SkillChangeEvent,
  SkillScope,
  SkillScopeResolver,
  SkillValidator,
} from "./lib/types.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const object = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null);
const limit = (max: number) => z.number().int().positive().max(max).optional();

/**
 * Lets the people who talk to an agent save their own versioned skills.
 * Experimental: this extension and its options may change in any release.
 * See `docs/experimental/custom-skills.md`.
 */
export default defineExtension({
  config: z.object({
    /**
     * The document store for skills. Defaults to private Vercel Blob when
     * `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` is set; without either, no
     * skills load and the tools report that storage is missing. Pass
     * `inMemory()` from `eve/memory/file` for local development and tests.
     */
    storage: object<MemoryDocumentBackend>().optional(),
    /**
     * Key prefix for every document in `storage`. Give each agent that shares
     * a store its own namespace, or they share every user's skills. Defaults
     * to `custom-skills`.
     */
    namespace: z.string().min(1).max(200).optional(),
    /** Your own storage, such as database tables. Replaces `storage`. */
    repository: object<SkillRepository>().optional(),
    /**
     * The scopes whose skills apply on a turn, in precedence order. Defaults
     * to `defaultScopes` from `eve/experimental/extensions/custom-skills/policies`: the
     * caller's personal skills plus the shared skills of the conversation's
     * channel or group.
     */
    scopes: fn<SkillScopeResolver>().optional(),
    approval: z
      .object({
        /**
         * Decides whether a change runs, asks a person, or is refused.
         * Defaults to `defaultSkillApproval`, which asks before publishing,
         * rolling back, or removing, and before any change goes live in a
         * shared scope.
         */
        request: fn<SkillApprovalRule>().optional(),
        /**
         * Decides who may answer an approval. Defaults to eve's rule: only the
         * person who asked.
         */
        response: fn<ApprovalResponsePolicy>().optional(),
      })
      .default({}),
    /**
     * Checks a skill's description and instructions on save, publish, and
     * mode changes. Replaces the built-in rules (`defaultSkillValidator` from
     * `eve/experimental/extensions/custom-skills/policies`): routing descriptions for
     * on-demand and deferred skills, and warnings for instructions that try to
     * override higher-priority rules. Required fields, `limits`, and control
     * characters are always checked.
     */
    validate: fn<SkillValidator>().optional(),
    limits: z
      .object({
        maxSkills: limit(10_000),
        maxAlwaysOn: limit(100),
        maxAlwaysOnCharacters: limit(200_000),
        maxNameLength: limit(64),
        maxDescriptionLength: limit(2_000),
        maxInstructionsLength: limit(200_000),
      })
      .default({}),
    /**
     * Called after each successful change, with who asked and who approved,
     * for audit logs or mirroring an inventory. Failures are logged, not
     * surfaced to the model.
     */
    onChange: fn<(event: SkillChangeEvent) => void | Promise<void>>().optional(),
  }),
});
