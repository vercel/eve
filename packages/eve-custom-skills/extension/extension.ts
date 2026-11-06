import { defineExtension } from "eve/extension";
import type { MemoryDocumentBackend } from "eve/memory/file";
import { z } from "zod";

import type { SkillRepository } from "./lib/repository.ts";
import type { SkillScopeResolver } from "./lib/scopes.ts";
import type { SkillChangeEvent, SkillScope } from "./lib/types.ts";

export type {
  AppendVersionRequest,
  AppendVersionResult,
  RemoveSkillsResult,
  SkillHead,
  SkillHeadPatch,
  SkillRepository,
  SkillVersionRecord,
} from "./lib/repository.ts";
export type { SkillScopeResolver } from "./lib/scopes.ts";
export type {
  SkillApplicationMode,
  SkillAuth,
  SkillChangeEvent,
  SkillScope,
  StoredSkill,
} from "./lib/types.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const object = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null);

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
     * Replaces the document store with your own storage, such as database
     * tables. Takes precedence over `storage`.
     */
    repository: object<SkillRepository<SkillScope>>().optional(),
    /**
     * Which owners' skills apply on a turn, in precedence order. Defaults to
     * the caller's personal skills plus the current Slack channel's skills.
     */
    scopes: fn<SkillScopeResolver>().optional(),
    limits: z
      .object({
        maxAlwaysOn: z.number().int().positive().optional(),
        maxAlwaysOnCharacters: z.number().int().positive().optional(),
      })
      .default({}),
    /** Called after each successful change, for example to mirror an inventory. */
    onChange: fn<(event: SkillChangeEvent) => void | Promise<void>>().optional(),
  }),
});
