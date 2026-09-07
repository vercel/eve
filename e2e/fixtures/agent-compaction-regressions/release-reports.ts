import { defineState } from "eve/context";

export type ReviewSubject = "repository" | "checkout";

export const reviewReferences = {
  repository: "reviews/storefront/repository",
  checkout: "reviews/storefront/checkout",
} as const;

export const handoffReferences = {
  repository: "handoffs/storefront/repository",
  checkout: "handoffs/storefront/checkout",
} as const;

export interface ReleaseRecord {
  readonly reportId: string;
  readonly subject: ReviewSubject;
  readonly status: "completed";
  readonly findings: readonly string[];
}

export const releaseRecords = defineState<Record<string, ReleaseRecord>>(
  "storefront.release-records",
  () => ({}),
);

export function saveReleaseRecord(record: ReleaseRecord): void {
  releaseRecords.update((records) => ({ ...records, [record.reportId]: record }));
}
