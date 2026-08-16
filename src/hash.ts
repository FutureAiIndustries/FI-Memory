import { createHash } from "node:crypto";

/** `sha256:<hex>` of the UTF-8 bytes of `text` — the form stored in proposals. */
export function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
