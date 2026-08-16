import { describe, expect, it } from "vitest";
import {
  idsCollide,
  levenshtein,
  prefixAwareJaccard,
  tokenize,
  tokensEqual,
} from "../src/fuzzy.js";

/**
 * The frozen golden-pair table (SPEC §2, rev 3). Must pass verbatim, in both
 * directions (the check is symmetric).
 */
const GOLDEN: Array<[string, string, boolean]> = [
  ["auth-patterns", "authentication-patterns", true], // prefix: auth≈authentication
  ["auth", "auth-patterns", true], // token overlap 0.5
  ["oauth-patterns", "auth-patterns", true], // Levenshtein 1 normalized
  ["fi-upload", "fi-uploads", true], // Levenshtein 1
  ["godot-headless-testing", "godot-headless-tests", true], // Jaccard 0.5
  ["hd2d-art-pipeline", "upload-pipeline", false], // overlap 0.25
  ["curfew-game", "crookmon-game", false], // overlap 0.33
  ["auth-patterns", "ui-conventions", false], // nothing in common
];

describe("fuzzy collision — golden pairs (SPEC §2 rev 3) pass verbatim", () => {
  for (const [a, b, shouldCollide] of GOLDEN) {
    it(`${a} vs ${b} → ${shouldCollide ? "match" : "no match"}`, () => {
      expect(idsCollide(a, b)).toBe(shouldCollide);
      expect(idsCollide(b, a)).toBe(shouldCollide); // symmetric
    });
  }
});

describe("fuzzy primitives", () => {
  it("levenshtein basics", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("authpatterns", "oauthpatterns")).toBe(1);
  });

  it("prefix-aware token equality (min length 4)", () => {
    expect(tokensEqual("auth", "authentication")).toBe(true);
    expect(tokensEqual("upload", "uploads")).toBe(true);
    expect(tokensEqual("art", "article")).toBe(false); // "art" < 4 chars
    expect(tokensEqual("testing", "tests")).toBe(false); // neither is a prefix
    expect(tokensEqual("game", "game")).toBe(true);
  });

  it("prefix-aware Jaccard values match the table annotations", () => {
    expect(prefixAwareJaccard(tokenize("auth"), tokenize("auth-patterns"))).toBe(
      0.5,
    );
    expect(
      prefixAwareJaccard(
        tokenize("hd2d-art-pipeline"),
        tokenize("upload-pipeline"),
      ),
    ).toBeCloseTo(0.25, 5);
    expect(
      prefixAwareJaccard(tokenize("curfew-game"), tokenize("crookmon-game")),
    ).toBeCloseTo(1 / 3, 5);
    expect(
      prefixAwareJaccard(
        tokenize("auth-patterns"),
        tokenize("authentication-patterns"),
      ),
    ).toBe(1); // auth≈authentication, patterns=patterns
  });
});
