// Company state. In-memory maps behind interfaces, so DynamoDB can replace them (Task 13).
import { MemoryReplayStore, rid, type ReplayStore } from "poppy-core";

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

export interface Stores {
  replay: ReplayStore;
  sessions: Map<string, Session>;
  tokens: Map<string, SessionToken>;
  codes: Map<string, AuthCode>;
  /** Keyed by the refresh token value. */
  accountTokens: Map<string, AccountToken>;
}

export function memoryStores(): Stores {
  return {
    replay: new MemoryReplayStore(),
    sessions: new Map(),
    tokens: new Map(),
    codes: new Map(),
    accountTokens: new Map(),
  };
}

export const newSessionId = (): string => `ses_${rid()}`;
export const newOpaqueToken = (): string => rid(32);
