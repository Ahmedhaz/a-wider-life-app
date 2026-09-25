// Passwords. PBKDF2-HMAC-SHA256 through Web Crypto, because Workers have no bcrypt, scrypt or
// argon2 and pulling in a WASM build of one is a bigger liability than a well-parameterised PBKDF2.
//
// Stored as `pbkdf2$<iterations>$<salt base64>$<hash base64>`. The iteration count travels with the
// hash, so raising it later does not invalidate anyone: verify reads the count from the record, and
// needsRehash() tells the caller when to write a stronger one after a successful login.

const ALG = "PBKDF2";
const HASH = "SHA-256";
const KEY_BITS = 256;
const SALT_BYTES = 16;

/** Current cost. Raise it as hardware allows; existing records keep verifying at their own count. */
export const ITERATIONS = 100_000;

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), ALG, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: ALG, salt: salt as BufferSource, iterations, hash: HASH }, key, KEY_BITS);
  return b64(bits);
}

export async function hashPassword(password: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2$${iterations}$${b64(salt)}$${await derive(password, salt, iterations)}`;
}

/** Constant-time compare, so a wrong password cannot be narrowed down by timing the response. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = String(stored).split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const n = Number(iter);
  if (!Number.isInteger(n) || n < 1000 || n > 5_000_000) return false;   // refuse a tampered cost
  try { return sameSecret(await derive(password, unb64(salt), n), hash); } catch { return false; }
}

/** True when a record was written at a lower cost than we now use, so it can be upgraded on login. */
export function needsRehash(stored: string): boolean {
  const n = Number(String(stored).split("$")[1]);
  return !Number.isInteger(n) || n < ITERATIONS;
}

// ---------- what we accept ----------

/** Deliberately loose. Anything with one @ and a dot after it; the address is an identifier here,
 *  not a channel, and over-strict patterns reject real addresses. */
export function normaliseEmail(input: unknown): string | null {
  const e = String(input ?? "").trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

export const MIN_PASSWORD = 8;

/** Length only, and a floor rather than a character-class puzzle: composition rules push people
 *  toward Passw0rd! and away from length, which is what actually costs an attacker. */
export function passwordProblem(password: unknown): string | null {
  const p = String(password ?? "");
  if (p.length < MIN_PASSWORD) return "password_too_short";
  if (p.length > 200) return "password_too_long";           // PBKDF2 cost is ours to bound
  return null;
}
