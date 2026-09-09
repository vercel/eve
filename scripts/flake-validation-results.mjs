export function isCleanEvalSummary(summary) {
  return (
    summary?.failed === 0 &&
    summary.scored === 0 &&
    summary.errored === 0 &&
    summary.skipped === 0 &&
    Array.isArray(summary.results) &&
    summary.results.length > 0 &&
    summary.passed === summary.results.length &&
    summary.results.every((result) => result?.verdict === "passed" && result.error === undefined)
  );
}

export function zeroFailureUpperBound(runs) {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("A confidence bound requires a positive integer trial count.");
  }
  return -Math.expm1(Math.log(0.05) / runs);
}
