// Copy codes: 15 letters from a 31-letter alphabet with no ambiguous glyphs (no 0, O, 1, I, L).
// 31^15 is about 2^74 possibilities, generated with crypto randomness and rejection sampling.

export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 characters
export const CODE_LEN = 15;

export function generateCode(): string {
  const out: string[] = [];
  const buf = new Uint8Array(64);
  while (out.length < CODE_LEN) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 248) continue;                 // 248 = 31 * 8, keeps the draw uniform
      out.push(ALPHABET[b % 31]);
      if (out.length === CODE_LEN) break;
    }
  }
  return out.join("");
}

/** Normalise what a person typed: uppercase, drop spaces and dashes. Anything outside the alphabet is rejected,
 *  never guessed: a key is not a word to autocorrect. */
export function normaliseCode(input: string): string | null {
  const clean = String(input ?? "").toUpperCase().replace(/[\s\-]/g, "");
  if (clean.length !== CODE_LEN) return null;
  for (const ch of clean) if (!ALPHABET.includes(ch)) return null;
  return clean;
}

/** Printed form: three groups of five. */
export function printedForm(code: string): string {
  return `${code.slice(0, 5)} ${code.slice(5, 10)} ${code.slice(10, 15)}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
