import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
}).strict();
export const SerpApiKeySchema = z.object({
  apiKey: z.string().trim().min(20).max(256).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const UserRowSchema = z.object({
  id: z.string(), email: z.string(), password_hash: z.string(),
  email_verified_at: z.string().nullable(), key_cipher: z.string().nullable(),
});
type UserRow = z.infer<typeof UserRowSchema>;
export interface Account {
  id: string;
  email: string;
  emailVerified: boolean;
  hasSerpApiKey: boolean;
  aiAttemptsToday: number;
  aiDailyLimit: number;
}
export class AccountError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const day = () => new Date().toISOString().slice(0, 10);

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => error ? reject(error) : resolve(result));
  });
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, digest] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !digest) throw new Error('Invalid stored password hash.');
  const expected = Buffer.from(digest, 'hex');
  const actual = await derive(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class AccountStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly encryptionKey: Buffer,
    private readonly dummyPasswordHash: string,
    readonly aiDailyLimit: number,
  ) {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version;
    if (version > 1) throw new Error('Account database is newer than this application.');
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, email_verified_at TEXT,
        key_cipher TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS ai_usage (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day TEXT NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(user_id, day)
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  private user(id: string): UserRow {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) throw new AccountError('Your session has expired. Sign in again.', 401);
    return UserRowSchema.parse(row);
  }
  account(id: string): Account {
    const row = this.user(id);
    const usage = this.db.prepare('SELECT attempts FROM ai_usage WHERE user_id = ? AND day = ?').get(id, day());
    return {
      id: row.id, email: row.email, emailVerified: row.email_verified_at !== null,
      hasSerpApiKey: row.key_cipher !== null,
      aiAttemptsToday: usage ? z.object({ attempts: z.number() }).parse(usage).attempts : 0,
      aiDailyLimit: this.aiDailyLimit,
    };
  }
  async register(email: string, password: string): Promise<Account> {
    const passwordHash = await hashPassword(password);
    if (this.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      throw new AccountError('Unable to register this email. Try signing in instead.', 409);
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, email, passwordHash, Date.now());
    return this.account(id);
  }
  async login(email: string, password: string): Promise<Account> {
    const raw = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const row = raw ? UserRowSchema.parse(raw) : undefined;
    const matches = await checkPassword(password, row?.password_hash ?? this.dummyPasswordHash);
    if (!row || !matches) throw new AccountError('Email or password is incorrect.', 401);
    return this.account(row.id);
  }
  createSession(userId: string): string {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
      (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 9)`).run(userId, userId);
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hash(token), userId, Date.now() + SESSION_MS, Date.now());
    return token;
  }
  authenticate(token: string | undefined): Account | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token), Date.now());
    return row ? this.account(z.object({ user_id: z.string() }).parse(row).user_id) : null;
  }
  logout(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  }
  saveKey(userId: string, apiKey: string): void {
    this.user(userId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`trendalyse:serpapi:${userId}`));
    const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const envelope = [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
    this.db.prepare('UPDATE users SET key_cipher = ? WHERE id = ?').run(envelope, userId);
  }
  getKey(userId: string): string | null {
    const envelope = this.user(userId).key_cipher;
    if (!envelope) return null;
    const [nonce, tag, encrypted] = envelope.split('.');
    if (!nonce || !tag || !encrypted) throw new Error('Stored SerpApi credential is invalid.');
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(nonce, 'base64'));
      cipher.setAAD(Buffer.from(`trendalyse:serpapi:${userId}`));
      cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt the saved SerpApi credential. Check ACCOUNT_ENCRYPTION_KEY and database integrity.');
    }
  }
  removeKey(userId: string): void {
    this.user(userId);
    this.db.prepare('UPDATE users SET key_cipher = NULL WHERE id = ?').run(userId);
  }
  consumeAiAttempt(userId: string): void {
    const row = this.db.prepare(`INSERT INTO ai_usage (user_id, day, attempts) VALUES (?, ?, 1)
      ON CONFLICT(user_id, day) DO UPDATE SET attempts = attempts + 1
      WHERE attempts < ? RETURNING attempts`).get(userId, day(), this.aiDailyLimit);
    if (!row) throw new AccountError(`Your ${this.aiDailyLimit} daily AI analysis attempts have been used. The allowance resets at midnight UTC.`, 429);
    this.db.prepare('DELETE FROM ai_usage WHERE day < ?').run(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  }
  close(): void { this.db.close(); }
}

export async function openAccountStore(path: string, encryptionKey: string, aiDailyLimit = 5): Promise<AccountStore> {
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error('ACCOUNT_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  // Load only for the website, keeping the Node 20 CLI independent of SQLite.
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite) throw new Error('The account-backed website requires Node.js 22.13 or newer.');
  const { DatabaseSync } = sqlite;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    return new AccountStore(db, Buffer.from(encryptionKey, 'hex'), await hashPassword(randomBytes(32).toString('hex')), aiDailyLimit);
  } catch (error) {
    db.close();
    throw error;
  }
}
