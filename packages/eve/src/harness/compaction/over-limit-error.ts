export class CompactionOverLimitError extends Error {
  override readonly name: string = "CompactionOverLimitError";
}

export class CompactionResultOverLimitError extends CompactionOverLimitError {
  override readonly name = "CompactionResultOverLimitError";
}
