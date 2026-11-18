import type { AccessScope } from "@shared/identity/access-scope";

export interface TRPCContext {
  readonly origin: string;
  readonly scope: AccessScope;
}
