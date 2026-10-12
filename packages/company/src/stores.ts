// Company state behind async interfaces (Task 13): in-memory maps for tests and local runs,
// DynamoDB (stores/dynamo.ts) for Lambda. Values are copied in and out, so a handler that changes
// a record and forgets to put it back fails the same way against both.
import { MemoryReplayStore, rid, type ReplayStore } from "poppy-core";
import type { PendingAuthz } from "./authorize.ts";
import { DEFAULT_TEST_USER, SECOND_TEST_USER, makeUser, type User } from "./users.ts";

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
}

export interface Tip {
  fixture_id: string;
  round: number;
  team: string;
  submitted_at: string;
}

/** A keyed collection. `expiresAt` (ms) makes an item invisible once passed. */
export interface Table<T> {
  get(id: string): Promise<T | undefined>;
  put(id: string, value: T, expiresAt?: number): Promise<void>;
  delete(id: string): Promise<void>;
  /** Reads and deletes in one step, so only one caller ever gets the item (codes, A-40). */
  take(id: string): Promise<T | undefined>;
}

export interface SessionTable extends Table<Session> {
  /** Signs out every Session signed in with this Account Token (spec 4.9). Returns how many. */
  signOutByAccountToken(accountTokenId: string): Promise<number>;
}

export interface TipTable {
  list(accountId: string): Promise<Tip[]>;
  put(accountId: string, tip: Tip): Promise<void>;
}

export interface Stores {
  replay: ReplayStore;
  sessions: SessionTable;
  tokens: Table<SessionToken>;
  codes: Table<AuthCode>;
  /** Keyed by the refresh token value. */
  accountTokens: Table<AccountToken>;
  /** Sign-in requests between the authorize redirect and consent. */
  pending: Table<PendingAuthz>;
  /** Keyed by username. */
  users: Table<User>;
  tips: TipTable;
}

export class MemoryTable<T> implements Table<T> {
  protected items = new Map<string, { value: T; expiresAt: number | undefined }>();

  async get(id: string): Promise<T | undefined> {
    const item = this.items.get(id);
    if (!item) return undefined;
    if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
      this.items.delete(id);
      return undefined;
    }
    return structuredClone(item.value);
  }

  async put(id: string, value: T, expiresAt?: number): Promise<void> {
    this.items.set(id, { value: structuredClone(value), expiresAt });
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async take(id: string): Promise<T | undefined> {
    const v = await this.get(id);
    this.items.delete(id);
    return v;
  }
}

export class MemorySessionTable extends MemoryTable<Session> implements SessionTable {
  async signOutByAccountToken(accountTokenId: string): Promise<number> {
    let n = 0;
    for (const item of this.items.values()) {
      if (item.value.accountTokenId === accountTokenId) {
        item.value.accountId = null;
        item.value.accountTokenId = null;
        n++;
      }
    }
    return n;
  }
}

export class MemoryTipTable implements TipTable {
  private tips = new Map<string, Map<string, Tip>>();

  async list(accountId: string): Promise<Tip[]> {
    return [...(this.tips.get(accountId)?.values() ?? [])].map((t) => structuredClone(t))
      .sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
  }

  async put(accountId: string, tip: Tip): Promise<void> {
    let m = this.tips.get(accountId);
    if (!m) this.tips.set(accountId, m = new Map());
    m.set(tip.fixture_id, structuredClone(tip));
  }
}

/** The demo's test users (HowToVerify): tipper, and rival for account_mismatch tests. */
export async function seedUsers(users: Table<User>): Promise<void> {
  for (const u of [DEFAULT_TEST_USER, SECOND_TEST_USER]) {
    if (!await users.get(u.username)) await users.put(u.username, makeUser(u.username, u.password));
  }
}

export function memoryStores(): Stores {
  const users = new MemoryTable<User>();
  void seedUsers(users);
  return {
    replay: new MemoryReplayStore(),
    sessions: new MemorySessionTable(),
    tokens: new MemoryTable(),
    codes: new MemoryTable(),
    accountTokens: new MemoryTable(),
    pending: new MemoryTable(),
    users,
    tips: new MemoryTipTable(),
  };
}

export const newSessionId = (): string => `ses_${rid()}`;
export const newOpaqueToken = (): string => rid(32);
