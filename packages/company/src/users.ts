// The demo's company accounts. One test user by default (SecurityReview residual: no real account security).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface User {
  username: string;
  accountId: string;
  /** scrypt: salt and hash, base64url */
  salt: string;
  hash: string;
}

export const DEFAULT_TEST_USER = { username: "tipper", password: "correct horse battery staple" };
/** A second account, for account_mismatch tests (A-43). */
export const SECOND_TEST_USER = { username: "rival", password: "battery staple horse correct" };

export function makeUser(username: string, password: string, accountId = `acct_${username}`): User {
  const salt = randomBytes(16);
  return { username, accountId, salt: salt.toString("base64url"),
    hash: scryptSync(password, salt, 32).toString("base64url") };
}

/** Constant-time password check. Unknown users still pay for a hash. */
export function checkPassword(u: User | undefined, password: string): User | undefined {
  const salt = u ? Buffer.from(u.salt, "base64url") : Buffer.alloc(16);
  const got = scryptSync(password, salt, 32);
  const want = u ? Buffer.from(u.hash, "base64url") : Buffer.alloc(32, 1);
  return timingSafeEqual(got, want) && u ? u : undefined;
}
