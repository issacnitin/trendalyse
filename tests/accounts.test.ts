import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialsSchema, openAccountStore, type AccountStore } from '../src/web/accounts.js';

const key = 'b'.repeat(64);
const password = 'correct horse battery staple';
let store: AccountStore | undefined;
let directory: string | undefined;
afterEach(() => {
  store?.close(); store = undefined;
  if (directory) rmSync(directory, { recursive: true });
  directory = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe.skipIf(Number(process.versions.node.split('.')[0]) < 22)('persistent customer accounts', () => {
  it('normalizes emails and rejects invalid credentials', () => {
    expect(CredentialsSchema.parse({ email: ' PERSON@EXAMPLE.COM ', password }).email).toBe('person@example.com');
    expect(CredentialsSchema.safeParse({ email: 'invalid', password: 'short' }).success).toBe(false);
  });
  it('persists accounts, encrypted credentials and quotas across reopen', async () => {
    directory = mkdtempSync(join(tmpdir(), 'trendalyse-accounts-'));
    const path = join(directory, 'accounts.sqlite');
    store = await openAccountStore(path, key);
    const user = await store.register('user@example.com', password);
    const secret = 'customer-serpapi-private-key-abcdef';
    store.saveKey(user.id, secret);
    store.consumeAiAttempt(user.id);
    const token = store.createSession(user.id);
    expect(store.getKey(user.id)).toBe(secret);
    store.close(); store = undefined;
    const disk = readFileSync(path).toString();
    expect(disk).not.toContain(secret);
    expect(disk).not.toContain(password);
    expect(disk).not.toContain(token);
    store = await openAccountStore(path, key);
    expect(store.getKey(user.id)).toBe(secret);
    expect(store.authenticate(token)).toMatchObject({ email: 'user@example.com', emailVerified: false, aiAttemptsToday: 1 });
    expect(await store.login('user@example.com', password)).toMatchObject({ id: user.id });
    await expect(store.login('user@example.com', 'wrong password here')).rejects.toThrow(/incorrect/);
    await expect(store.register('user@example.com', password)).rejects.toThrow(/Unable to register/);
  });
  it('does not decrypt another account ciphertext or accept a wrong master key', async () => {
    directory = mkdtempSync(join(tmpdir(), 'trendalyse-accounts-'));
    const path = join(directory, 'accounts.sqlite');
    store = await openAccountStore(path, key);
    const a = await store.register('a@example.com', password);
    const b = await store.register('b@example.com', password);
    store.saveKey(a.id, 'a-private-serpapi-key-123456');
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const inspect = new DatabaseSync(path);
    inspect.prepare('UPDATE users SET key_cipher = (SELECT key_cipher FROM users WHERE id = ?) WHERE id = ?').run(a.id, b.id);
    inspect.close();
    expect(() => store?.getKey(b.id)).toThrow(/Could not decrypt/);
    store.close(); store = await openAccountStore(path, 'c'.repeat(64));
    expect(() => store?.getKey(a.id)).toThrow(/Could not decrypt/);
  });
  it('isolates quotas, resets them at midnight UTC and expires sessions', async () => {
    store = await openAccountStore(':memory:', key);
    const a = await store.register('a@example.com', password);
    const b = await store.register('b@example.com', password);
    const now = Date.now();
    for (let i = 0; i < 5; i++) store.consumeAiAttempt(a.id);
    expect(() => store?.consumeAiAttempt(a.id)).toThrow(/daily AI/);
    expect(store.account(b.id).aiAttemptsToday).toBe(0);
    const token = store.createSession(a.id);
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86400000);
    expect(store.authenticate(token)).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(now + 8 * 86400000);
    expect(store.account(a.id).aiAttemptsToday).toBe(0);
    store.consumeAiAttempt(a.id);
    expect(store.account(a.id).aiAttemptsToday).toBe(1);
    vi.useRealTimers();
  });
});
