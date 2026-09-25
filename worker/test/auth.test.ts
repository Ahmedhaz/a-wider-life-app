import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, needsRehash, normaliseEmail, passwordProblem, ITERATIONS } from "../src/auth";

describe("password hashing", () => {
  it("verifies the right password and refuses the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts, so the same password never stores the same hash", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("records the cost with the hash, so old records keep working after a raise", async () => {
    const cheap = await hashPassword("pw", 1000);
    expect(cheap.startsWith("pbkdf2$1000$")).toBe(true);
    expect(await verifyPassword("pw", cheap)).toBe(true);     // still verifies at its own count
    expect(needsRehash(cheap)).toBe(true);
    expect(needsRehash(await hashPassword("pw"))).toBe(false);
  });

  it("never throws on a malformed or tampered record, it just fails", async () => {
    for (const bad of ["", "garbage", "pbkdf2$", "pbkdf2$abc$x$y", "bcrypt$10$x$y", "pbkdf2$1$x$y", "pbkdf2$99999999$x$y"]) {
      expect(await verifyPassword("pw", bad)).toBe(false);
    }
  });

  it("uses a cost worth the name", () => {
    expect(ITERATIONS).toBeGreaterThanOrEqual(100_000);
  });
});

describe("what we accept", () => {
  it("lowercases and trims an email", () => {
    expect(normaliseEmail("  Ahmed.Abu@Example.COM ")).toBe("ahmed.abu@example.com");
  });
  it("refuses what is not an address", () => {
    for (const bad of ["", "ahmed", "ahmed@", "@example.com", "a b@c.com", "ahmed@example", null, undefined, 42])
      expect(normaliseEmail(bad)).toBeNull();
  });
  it("accepts the shapes real addresses take", () => {
    for (const ok of ["a+tag@example.co.uk", "first.last@sub.domain.io", "x@y.z"])
      expect(normaliseEmail(ok)).toBe(ok);
  });
  it("asks for length, not a character puzzle", () => {
    expect(passwordProblem("short")).toBe("password_too_short");
    expect(passwordProblem("12345678")).toBeNull();
    expect(passwordProblem("a".repeat(201))).toBe("password_too_long");
    expect(passwordProblem(null)).toBe("password_too_short");
  });
});
