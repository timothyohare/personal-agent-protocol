// DynamoDB stores (Task 13, PRD F13): one table, conditional writes so single-use checks hold
// across Lambda instances, and DynamoDB TTL for clean-up. Expiry is also checked on every read,
// because TTL deletion can lag by hours.
//
// Table: partition key `pk` (S), sort key `sk` (S). Items carry the record in `v`, an exact expiry
// `exp` (ms) and a TTL `ttl` (s). Sessions also carry `atid` for the `atid-index` GSI, which finds
// the Sessions to sign out when an Account Token is revoked.
import { ConditionalCheckFailedException, CreateTableCommand, DynamoDBClient, ResourceInUseException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ConversationEvent, ReplayStore } from "poppy-core";
import { newEventId, type Conversation, type ConversationStores, type EventLog, type MessageRecord } from "../conversations/store.ts";
import type { PendingAuthz } from "../authorize.ts";
import type {
  AccountToken, AuthCode, Session, SessionTable, SessionToken, Stores, Table, Tip, TipTable,
} from "../stores.ts";
import { seedUsers } from "../stores.ts";
import type { User } from "../users.ts";

export const ATID_INDEX = "atid-index";
const NO_SORT = "-";

export interface DynamoOptions {
  table: string;
  /** e.g. http://localhost:8000 for DynamoDB Local. */
  endpoint?: string;
  region?: string;
  /** Prefixes every key, so several test companies can share one table. */
  namespace?: string;
}

export function dynamoClient(o: DynamoOptions): DynamoDBDocumentClient {
  const local = o.endpoint !== undefined;
  const raw = new DynamoDBClient({
    region: o.region ?? process.env.AWS_REGION ?? "ap-southeast-2",
    ...(local ? { endpoint: o.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
  });
  return DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
}

/** Creates the table and its GSI if they don't exist (local runs and tests; SAM creates it in the cloud). */
export async function ensureTable(o: DynamoOptions): Promise<void> {
  const client = dynamoClient(o);
  try {
    await client.send(new CreateTableCommand({
      TableName: o.table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "atid", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      GlobalSecondaryIndexes: [{
        IndexName: ATID_INDEX, KeySchema: [{ AttributeName: "atid", KeyType: "HASH" }],
        Projection: { ProjectionType: "KEYS_ONLY" },
      }],
    }));
  } catch (e) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

const ttlSeconds = (expMs: number) => Math.ceil(expMs / 1000) + 60;

class Base {
  protected readonly db: DynamoDBDocumentClient;
  protected readonly table: string;
  protected readonly prefix: string;

  constructor(db: DynamoDBDocumentClient, table: string, prefix: string) {
    this.db = db;
    this.table = table;
    this.prefix = prefix;
  }
}

export class DynamoTable<T> extends Base implements Table<T> {
  protected key(id: string) {
    return { pk: `${this.prefix}#${id}`, sk: NO_SORT };
  }

  protected live(item: Record<string, unknown> | undefined): T | undefined {
    if (!item) return undefined;
    if (typeof item.exp === "number" && item.exp <= Date.now()) return undefined;
    return item.v as T;
  }

  /** Extra attributes stored beside the value (sessions add `atid`). */
  protected extra(_value: T): Record<string, unknown> {
    return {};
  }

  async get(id: string): Promise<T | undefined> {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: this.key(id), ConsistentRead: true }));
    return this.live(r.Item);
  }

  async put(id: string, value: T, expiresAt?: number): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: {
      ...this.key(id), v: value, ...this.extra(value),
      ...(expiresAt !== undefined ? { exp: expiresAt, ttl: ttlSeconds(expiresAt) } : {}),
    } }));
  }

  async delete(id: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: this.key(id) }));
  }

  async create(id: string, value: T, expiresAt?: number): Promise<boolean> {
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: {
        ...this.key(id), v: value, ...this.extra(value),
        ...(expiresAt !== undefined ? { exp: expiresAt, ttl: ttlSeconds(expiresAt) } : {}),
      }, ConditionExpression: "attribute_not_exists(pk) OR exp <= :now", ExpressionAttributeValues: { ":now": Date.now() } }));
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }

  /**
   * A conditional DeleteItem returning the old item. The condition matters: without it, concurrent
   * deletes can each get the old item back (seen with DynamoDB Local: 5 of 20 parallel code
   * exchanges succeeded). With it, every caller after the first fails the condition.
   */
  async take(id: string): Promise<T | undefined> {
    try {
      const r = await this.db.send(new DeleteCommand({ TableName: this.table, Key: this.key(id), ReturnValues: "ALL_OLD",
        ConditionExpression: "attribute_exists(pk)" }));
      return this.live(r.Attributes);
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return undefined;
      throw e;
    }
  }
}

export class DynamoSessionTable extends DynamoTable<Session> implements SessionTable {
  protected override extra(s: Session) {
    return s.accountTokenId ? { atid: `${this.prefix}#${s.accountTokenId}` } : {};
  }

  async signOutByAccountToken(accountTokenId: string): Promise<number> {
    const atid = `${this.prefix}#${accountTokenId}`;
    let n = 0;
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(new QueryCommand({ TableName: this.table, IndexName: ATID_INDEX,
        KeyConditionExpression: "atid = :a", ExpressionAttributeValues: { ":a": atid }, ExclusiveStartKey: start }));
      for (const key of r.Items ?? []) {
        try {
          // Only if it's still signed in with this Account Token (a later sign-in wins).
          await this.db.send(new UpdateCommand({ TableName: this.table, Key: { pk: key.pk, sk: key.sk },
            UpdateExpression: "SET v.accountId = :null, v.accountTokenId = :null REMOVE atid",
            ConditionExpression: "atid = :a", ExpressionAttributeValues: { ":null": null, ":a": atid } }));
          n++;
        } catch (e) {
          if (!(e instanceof ConditionalCheckFailedException)) throw e;
        }
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return n;
  }
}

export class DynamoTipTable extends Base implements TipTable {
  async list(accountId: string): Promise<Tip[]> {
    const tips: Tip[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": `${this.prefix}#${accountId}` }, ExclusiveStartKey: start }));
      for (const item of r.Items ?? []) tips.push(item.v as Tip);
      start = r.LastEvaluatedKey;
    } while (start);
    return tips.sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
  }

  async put(accountId: string, tip: Tip): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table,
      Item: { pk: `${this.prefix}#${accountId}`, sk: tip.fixture_id, v: tip } }));
  }
}

/** A conditional put: the key is new, or its previous use has expired (A-40 across instances). */
export class DynamoReplayStore extends Base implements ReplayStore {
  async checkAndAdd(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    try {
      await this.db.send(new PutCommand({ TableName: this.table,
        Item: { pk: `${this.prefix}#${key}`, sk: NO_SORT, exp: now + ttlMs, ttl: ttlSeconds(now + ttlMs) },
        ConditionExpression: "attribute_not_exists(pk) OR exp <= :now", ExpressionAttributeValues: { ":now": now } }));
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }
}

export async function dynamoStores(o: DynamoOptions): Promise<Stores> {
  const db = dynamoClient(o);
  const ns = o.namespace ? `${o.namespace}#` : "";
  const t = <T>(kind: string) => new DynamoTable<T>(db, o.table, `${ns}${kind}`);
  const users = t<User>("user");
  await seedUsers(users);
  return {
    replay: new DynamoReplayStore(db, o.table, `${ns}replay`),
    sessions: new DynamoSessionTable(db, o.table, `${ns}session`),
    tokens: t<SessionToken>("token"),
    codes: t<AuthCode>("code"),
    accountTokens: t<AccountToken>("at"),
    pending: t<PendingAuthz>("pending"),
    users,
    tips: new DynamoTipTable(db, o.table, `${ns}tips`),
  };
}

/**
 * The conversation event log: a per-conversation counter (an atomic ADD) gives each event its
 * position, so events keep their order across Lambda instances.
 */
export class DynamoEventLog extends Base implements EventLog {
  async append(conversationId: string, e: Parameters<EventLog["append"]>[1]): Promise<ConversationEvent> {
    const r = await this.db.send(new UpdateCommand({ TableName: this.table,
      Key: { pk: `${this.prefix}seq#${conversationId}`, sk: NO_SORT },
      UpdateExpression: "ADD n :one", ExpressionAttributeValues: { ":one": 1 }, ReturnValues: "UPDATED_NEW" }));
    const seq = Number(r.Attributes!.n);
    const event = { ...e, id: newEventId(), created_at: new Date().toISOString() } as ConversationEvent;
    await this.db.send(new PutCommand({ TableName: this.table,
      Item: { pk: `${this.prefix}evt#${conversationId}`, sk: String(seq).padStart(10, "0"), v: event } }));
    return event;
  }

  async list(conversationId: string): Promise<ConversationEvent[]> {
    const out: ConversationEvent[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": `${this.prefix}evt#${conversationId}` }, ConsistentRead: true, ExclusiveStartKey: start }));
      for (const item of r.Items ?? []) out.push(item.v as ConversationEvent);
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }
}

export function dynamoConversationStores(o: DynamoOptions): ConversationStores {
  const db = dynamoClient(o);
  const ns = o.namespace ? `${o.namespace}#` : "";
  return {
    conversations: new DynamoTable<Conversation>(db, o.table, `${ns}cnv`),
    messages: new DynamoTable<MessageRecord>(db, o.table, `${ns}msg`),
    events: new DynamoEventLog(db, o.table, ns),
  };
}
