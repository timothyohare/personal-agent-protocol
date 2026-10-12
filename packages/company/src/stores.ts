// Company state. In-memory maps behind interfaces, so DynamoDB can replace them (Task 13).
import { MemoryReplayStore, rid, type ReplayStore } from "poppy-core";
import type { PendingAuthz } from "./authorize.ts";
import { DEFAULT_TEST_USER, makeUser, type User } from "./users.ts";

export interface Session {
  id: string;
  clientId: string;
  userId: string;
  /** The account this Session is signed in to, or null when signed out. */
  accountId: string | null;
  /** The Account Token that signed it in (revoking that token signs it out). */
  accountTokenId: string | null;
  ended: boolean;
  createdAt: number;
}

export interface SessionToken {
  token: string;
  sessionId: string;
  /** Thumbprint of the DPoP key the token is bound to. */
  jkt: string;
  /** The account this token was issued for, or null for a signed-out token. */
  accountId: string | null;
  /** The Account Token behind this signed-in token. Revoking it signs the token out (F11). */
  accountTokenId: string | null;
  scope: string[];
  expiresAt: number;
  /** A Bearer MCP token's resource (Task 20). Undefined for DPoP tokens. */
  resource?: string;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  accountId: string;
  expiresAt: number;
}

export interface AccountToken {
  id: string;
  token: string;
  clientId: string;
  userId: string;
  accountId: string;
  scope: string[];
  revoked: boolean;
}

export interface Tip {
  fixture_id: string;
  round: number;
  team: string;
  submitted_at: string;
}

export interface Stores {
  replay: ReplayStore;
  sessions: Map<string, Session>;
  tokens: Map<string, SessionToken>;
  codes: Map<string, AuthCode>;
  /** Keyed by the refresh token value. */
  accountTokens: Map<string, AccountToken>;
  /** Sign-in requests between the authorize redirect and consent. */
  pending: Map<string, PendingAuthz>;
  /** Keyed by username. */
  users: Map<string, User>;
  /** Tips by account, then by fixture. */
  tips: Map<string, Map<string, Tip>>;
}

export function memoryStores(): Stores {
  return {
    replay: new MemoryReplayStore(),
    sessions: new Map(),
    tokens: new Map(),
    codes: new Map(),
    accountTokens: new Map(),
    pending: new Map(),
    users: new Map([[DEFAULT_TEST_USER.username, makeUser(DEFAULT_TEST_USER.username, DEFAULT_TEST_USER.password)]]),
    tips: new Map(),
  };
}

export const newSessionId = (): string => `ses_${rid()}`;
export const newOpaqueToken = (): string => rid(32);
