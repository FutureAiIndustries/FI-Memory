import { GestaltError } from "./errors.js";

/** Topic id: kebab-case `[a-z0-9-]{2,64}`, globally unique (SPEC §2). */
const ID_RE = /^[a-z0-9-]{2,64}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function assertValidId(id: string): void {
  if (!isValidId(id)) {
    throw new GestaltError(
      "E_INVALID_ID",
      `"${id}" is not a valid topic id (2–64 characters of a–z, 0–9, hyphen).`,
      `fimemory create <valid-id> --title "..."`,
    );
  }
}
