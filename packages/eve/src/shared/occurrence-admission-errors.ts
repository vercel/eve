export class OccurrenceAdmissionPendingError extends Error {
  constructor() {
    super("Scheduled occurrence initialization is pending; retry delivery.");
  }
}

export class OccurrenceAdmissionFailedError extends Error {
  constructor() {
    super(
      "Scheduled occurrence failed before admission; invoke explicitly to try a new occurrence.",
    );
  }
}
