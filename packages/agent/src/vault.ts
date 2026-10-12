// Secret storage for Account Tokens, DPoP private keys and User IDs (Task 8, S5 F2, T-13).
// The file vault is AES-256-GCM encrypted with a key held in a separate 0600 key file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Vault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryVault implements Vault {
  private data = new Map<string, string>();
  async get(key: string) { return this.data.get(key); }
  async set(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
}

function writePrivate(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** An encrypted JSON file. The key file is created on first use (32 random bytes, 0600). */
export class FileVault implements Vault {
  private readonly path: string;
  private readonly key: Buffer;

  constructor(path: string, keyPath: string) {
    this.path = path;
    if (!existsSync(keyPath)) writePrivate(keyPath, randomBytes(32));
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("vault key must be 32 bytes");
  }

  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    const { iv, tag, data } = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv!, "base64"));
    d.setAuthTag(Buffer.from(tag!, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data!, "base64")), d.final()]).toString("utf8"));
  }

  private save(obj: Record<string, string>): void {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
    writePrivate(this.path, JSON.stringify({
      v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"),
    }));
  }

  async get(key: string) { return this.load()[key]; }
  async set(key: string, value: string) { this.save({ ...this.load(), [key]: value }); }
  async delete(key: string) {
    const o = this.load();
    delete o[key];
    this.save(o);
  }
}
