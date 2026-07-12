/**
 * Process exit codes, documented so agents can branch on them without parsing
 * text. Mirrored in the README exit-code table.
 */
export const ExitCode = {
  OK: 0,
  USAGE: 2,
  /** Resource busy and --wait was not given. */
  BUSY: 10,
  /** --wait/--timeout elapsed without acquiring. */
  TIMEOUT: 11,
  /** Our fence token was superseded (we lost the lock to a steal/stale-break). */
  SUPERSEDED: 12,
  /** Target is held in until-approved mode and needs a human. */
  HELD_FOR_APPROVAL: 13,
  /** Could not take the coordination gate in time (contention/corruption). */
  GATE_TIMEOUT: 20,
  /** Any other runtime error. */
  ERROR: 1,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
