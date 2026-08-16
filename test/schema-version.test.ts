/**
 * Phase B — SCHEMA_VERSION gate (CROSS-MACHINE-PLAN-MERGED §8.2).
 *
 * Client lower than store ⇒ refuse write. Reads stay open. Absent schema.json
 * ⇒ implicit version 1 (legacy stores keep working).
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { GestaltError } from "../src/errors.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { list } from "../src/ops/list.js";
import { migrateToEncrypted } from "../src/ops/migrateEncrypt.js";
import { fsPath, storePaths } from "../src/paths.js";
import {
  CLIENT_SCHEMA_VERSION,
  assertStoreWritable,
  readStoreSchemaVersion,
  serializeSchemaFile,
} from "../src/store/schema.js";
import { freshHome } from "./helpers.js";

describe("store schema version (Phase B)", () => {
  it("init writes schema.json at CLIENT_SCHEMA_VERSION", () => {
    const home = freshHome("schema-init");
    runInit({ home });
    const p = storePaths(home).schema;
    expect(readStoreSchemaVersion(home)).toBe(CLIENT_SCHEMA_VERSION);
    // Must be plaintext on disk (readable without a key).
    const body = JSON.parse(readFileSync(fsPath(p), "utf8"));
    expect(body.schema_version).toBe(CLIENT_SCHEMA_VERSION);
  });

  it("absent schema.json is implicit version 1 (legacy stores still writable)", async () => {
    const home = freshHome("schema-legacy");
    runInit({ home });
    // Remove the file init wrote to simulate a pre-Phase-B store.
    unlinkSync(fsPath(storePaths(home).schema));
    expect(readStoreSchemaVersion(home)).toBe(1);
    expect(() => assertStoreWritable(home)).not.toThrow();
    await expect(
      appendLog(home, "gestalt-example", {
        type: "gotcha",
        project: "test",
        agent: "schema-test",
        summary: "legacy store without schema.json still accepts writes",
      }),
    ).resolves.toBeTruthy();
  });

  it("client lower than store refuses write with E_SCHEMA and upgrade hint", async () => {
    const home = freshHome("schema-skew");
    runInit({ home });
    writeFileSync(
      fsPath(storePaths(home).schema),
      serializeSchemaFile(CLIENT_SCHEMA_VERSION + 1),
      "utf8",
    );
    expect(readStoreSchemaVersion(home)).toBe(CLIENT_SCHEMA_VERSION + 1);
    expect(() => assertStoreWritable(home)).toThrow(GestaltError);
    try {
      assertStoreWritable(home);
    } catch (e) {
      const err = e as GestaltError;
      expect(err.code).toBe("E_SCHEMA");
      expect(err.message).toMatch(/format/);
      expect(err.hint).toMatch(/Upgrade/i);
    }
    await expect(
      createTopic(home, "should-fail", "Should not be created"),
    ).rejects.toMatchObject({ code: "E_SCHEMA" });
  });

  it("reads still work when store is newer than client", async () => {
    const home = freshHome("schema-read");
    runInit({ home });
    writeFileSync(
      fsPath(storePaths(home).schema),
      serializeSchemaFile(CLIENT_SCHEMA_VERSION + 5),
      "utf8",
    );
    // list is lock-free — must not hit the write gate
    const listed = await list(home);
    expect(listed.rows.length).toBeGreaterThan(0);
  });

  it("serializeSchemaFile is stable JSON with trailing newline", () => {
    const s = serializeSchemaFile(1);
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s)).toEqual({ schema_version: 1, min_reader: 1 });
  });

  it("empty home with no schema is writable (implicit v1)", () => {
    const home = freshHome("schema-empty");
    mkdirSync(path.join(home), { recursive: true });
    expect(readStoreSchemaVersion(home)).toBe(1);
    expect(() => assertStoreWritable(home)).not.toThrow();
  });

  it("encrypt preserves schema.json as plaintext without a non-standard-file warning", async () => {
    const home = freshHome("schema-encrypt");
    runInit({ home });
    expect(readStoreSchemaVersion(home)).toBe(CLIENT_SCHEMA_VERSION);
    const warnings: string[] = [];
    await migrateToEncrypted({
      home,
      passphrase: "a solid migration passphrase here",
      argon2: { name: "argon2id", m: 256, t: 1, p: 1 },
      allowWeakParams: true,
      warn: (msg) => warnings.push(msg),
    });
    // Still readable without a key (codec never seals it).
    expect(readStoreSchemaVersion(home)).toBe(CLIENT_SCHEMA_VERSION);
    const onDisk = readFileSync(fsPath(storePaths(home).schema), "utf8");
    expect(onDisk).toContain('"schema_version"');
    expect(onDisk.startsWith("gestalt-enc:")).toBe(false);
    // PRESERVED — not the "carried as plaintext" security yell.
    expect(warnings.join("\n")).not.toMatch(/schema\.json/);
  });
});
