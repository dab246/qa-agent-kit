/** Process exit codes. CI must treat every non-zero code as a failed required check. */
export const ExitCode = {
  GO: 0,
  /** NO_GO with a definite failure: violation, failed required test, failed manual E2E. */
  NO_GO_FAILED: 1,
  /** NO_GO because evidence, approvals or results are missing, blocked or inconclusive. */
  NO_GO_NEEDS_REVIEW: 2,
  /** Configuration or input is invalid; the gate could not be evaluated safely. */
  INVALID_INPUT: 3,
  /** Unexpected internal error. */
  INTERNAL_ERROR: 4,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeForVerdict(verdict: "GREEN" | "AMBER" | "RED"): ExitCode {
  if (verdict === "GREEN") return ExitCode.GO;
  return verdict === "RED" ? ExitCode.NO_GO_FAILED : ExitCode.NO_GO_NEEDS_REVIEW;
}
