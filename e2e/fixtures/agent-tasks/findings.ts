// The research archive's findings, shared by the researcher's tool and the
// evals that check a finding reached the final reply.

export interface ArchiveFinding {
  readonly findingId: string;
  readonly note: string;
}

export const EMEA_CHURN: ArchiveFinding = {
  findingId: "FND-EMEA-3K7",
  note: "EMEA churn fell to 2.1% in Q3, down from 2.6% in Q2, led by fewer annual-plan cancellations.",
};

export const APAC_CHURN: ArchiveFinding = {
  findingId: "FND-APAC-9Q2",
  note: "APAC churn rose to 3.4% in Q3, up from 2.9% in Q2, mostly among monthly self-serve plans.",
};

export const GENERAL_CHURN: ArchiveFinding = {
  findingId: "FND-GLOBAL-5M1",
  note: "Global churn held at 2.7% in Q3; the archive has regional breakdowns for EMEA and APAC.",
};

/** The finding for a question: the archive answers by region. */
export function findChurnNote(question: string): ArchiveFinding {
  const normalized = question.toUpperCase();
  if (normalized.includes("APAC")) return APAC_CHURN;
  if (normalized.includes("EMEA")) return EMEA_CHURN;
  return GENERAL_CHURN;
}
