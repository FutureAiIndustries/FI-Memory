// Closed error catalog for v1 (SPEC §5.10) + the warning shape (SPEC §5.8).

export const ERROR_CODES = [
  "E_NOT_FOUND",
  "E_EXISTS",
  "E_ALIAS_COLLISION",
  "E_INVALID_ID",
  "E_INVALID_TYPE",
  "E_TOKEN_CAP",
  "E_PROPOSAL_CAP",
  "E_LOCKED",
  "E_STALE_PROPOSAL",
  "E_PENDING_PROPOSALS",
  "E_OWNER_NOTES",
  "E_SCHEMA",
  "E_CORRUPT_SKIPPED",
  "E_STORE_MODE",
  // A file that EXISTS but could not be read (EACCES/EBUSY/EISDIR — an editor,
  // antivirus, or indexer holding it open). Distinct from E_NOT_FOUND on
  // purpose: reporting "no such topic" for a note that is merely locked tells
  // the user their memory is gone when it is not (§5.10).
  "E_IO",
  // Two machine-scoped proposals share the same human-facing seq after a merge.
  "E_AMBIGUOUS",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A structured runtime error. Every error carries a copy-pastable `hint`
 * naming the next command (SPEC §5: errors are `{ code, message, hint }`).
 */
export class GestaltError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;

  constructor(code: ErrorCode, message: string, hint: string) {
    super(message);
    this.name = "GestaltError";
    this.code = code;
    this.hint = hint;
  }

  toJSON(): { code: ErrorCode; message: string; hint: string } {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

/** Every structured result carries `warnings[]` (SPEC §5.8). */
export interface Warning {
  id?: string;
  code: string;
  message: string;
}
