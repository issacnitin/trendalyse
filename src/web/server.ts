import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { LlmClient } from '../llm/client.js';
import { createLogger, type Logger } from '../logger.js';
import { analyzeTrends } from '../trends/analyze.js';
import { TrendQuerySchema, TrendsClient, TrendsError, type SerpApiAccount, type TrendData, type TrendQuery } from '../trends/client.js';
import { AccountError, CredentialsSchema, SerpApiKeySchema, openAccountStore, type AccountStore } from './accounts.js';

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    ACCOUNT_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'must be 64 hexadecimal characters'),
    ACCOUNT_DATABASE_PATH: z.string().min(1).default('./data/accounts.sqlite'),
    AI_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  }).parse(env);
  if (new URL(config.WEB_ORIGIN).origin !== config.WEB_ORIGIN) throw new Error('WEB_ORIGIN must be an origin with no path or trailing slash.');
  if (config.NODE_ENV === 'production' && !config.WEB_ORIGIN.startsWith('https://')) throw new Error('Production WEB_ORIGIN must use HTTPS.');
  return config;
}
export type WebConfig = ReturnType<typeof loadWebConfig>;
export interface WebServices {
  trends: (userId: string, apiKey: string, query: TrendQuery, signal: AbortSignal) => Promise<TrendData>;
  analyze: (data: TrendData, signal: AbortSignal) => Promise<unknown>;
  forgetUser: (userId: string) => void;
  verifyKey: (apiKey: string, signal: AbortSignal) => Promise<SerpApiAccount>;
  aiReady: boolean;
}
class WindowLimiter {
  private readonly entries = new Map<string, { count: number; expires: number }>();
  constructor(private readonly limit: number, private readonly duration: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 1000) return false;
      entry = { count: 0, expires: now + this.duration };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }
}
function send(res: ServerResponse, status: number, data: unknown): void {
  if (status >= 400) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 4096) throw new AccountError('Request body exceeds 4 KB.', 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new AccountError('Send valid JSON.', 400); }
}
function sessionToken(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function createWebServer(config: WebConfig, services: WebServices, logger: Logger, accounts: AccountStore) {
  let active = 0;
  let activeAuth = 0;
  const globalRate = new WindowLimiter(20, 60_000);
  const userRate = new WindowLimiter(10, 60_000);
  const authGlobal = new WindowLimiter(60, 60_000);
  const authIp = new WindowLimiter(10, 600_000);
  const settingsRate = new WindowLimiter(5, 60_000);
  const cookieName = config.NODE_ENV === 'production' ? '__Host-trendalyse-session' : 'trendalyse-session';
  function cookie(res: ServerResponse, token: string, maxAge: number): void {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/market-research-using-ai', ['market-research-using-ai.html', 'text/html; charset=utf-8']],
    ['/login', ['login.html', 'text/html; charset=utf-8']],
    ['/dashboard', ['dashboard.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/research.css', ['research.css', 'text/css; charset=utf-8']],
    ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']],
    ['/sitemap.xml', ['sitemap.xml', 'application/xml; charset=utf-8']],
    ['/images/research-map.svg', ['images/research-map.svg', 'image/svg+xml']],
    ['/images/search-signals.svg', ['images/search-signals.svg', 'image/svg+xml']],
    ['/images/idea-validation.svg', ['images/idea-validation.svg', 'image/svg+xml']],
  ]);
  let assetVersion: Promise<string> | undefined;
  async function versionPageAssets(html: string): Promise<string> {
    assetVersion ??= (async () => {
      const directory = new URL('./public/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => /\.(?:html|css|js|ts)$/.test(name)).sort();
      const files = await Promise.all(names.map(async (name) => [name, await readFile(new URL(name, directory))] as const));
      const hash = createHash('sha256');
      for (const [name, content] of files) hash.update(name).update('\0').update(content).update('\0');
      return hash.digest('hex').slice(0, 16);
    })();
    const version = await assetVersion;
    return html.replace(/\b(href|src)="(\/[^"?]+\.(?:css|js))"/g, `$1="$2?v=${version}"`);
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const path = req.url?.split('?')[0] ?? '/';
    if (!assets.has(path) || path === '/login' || path === '/dashboard') {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
    if (req.method === 'GET' && path === '/healthz') { send(res, 200, { status: 'ok' }); return; }
    if (req.method === 'GET' && path === '/api/status') {
      send(res, 200, { aiReady: services.aiReady, authRequired: true, emailVerificationEnabled: false }); return;
    }
    const token = sessionToken(req, cookieName);
    const asset = assets.get(path);
    if ((req.method === 'GET' || req.method === 'HEAD') && asset) {
      if (path === '/dashboard' || path === '/login') {
        const user = accounts.authenticate(token);
        const redirect = path === '/dashboard' && !user ? '/login' : path === '/login' && user ? '/dashboard' : undefined;
        if (redirect) {
          res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
          res.end(); return;
        }
      }
      const [name, mime] = asset;
      let content = await readFile(new URL(`./public/${name ?? ''}`, import.meta.url));
      if (mime?.startsWith('text/html')) content = Buffer.from(await versionPageAssets(content.toString('utf8')));
      if (path === '/') {
        const structuredData = content.toString('utf8').match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
        if (structuredData) {
          const hash = createHash('sha256').update(structuredData).digest('base64');
          const csp = String(res.getHeader('Content-Security-Policy'));
          res.setHeader('Content-Security-Policy', csp.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`));
        }
      }
      res.writeHead(200, { 'Content-Type': mime ?? 'text/plain', 'Cache-Control': path === '/dashboard' || path === '/login' ? 'no-store' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content); return;
    }
    if (req.method === 'GET' && path === '/api/me') {
      send(res, 200, { user: accounts.authenticate(token), aiReady: services.aiReady, emailVerificationEnabled: false }); return;
    }
    const expectedMethod = path === '/api/account/serpapi' ? ['GET'] : path === '/api/account/key' ? ['PUT', 'DELETE'] :
      ['/api/register', '/api/login', '/api/logout', '/api/trends', '/api/analyze'].includes(path) ? ['POST'] : [];
    if (!expectedMethod.length) { send(res, 404, { error: 'Not found.' }); return; }
    if (!expectedMethod.includes(req.method ?? '')) { res.setHeader('Allow', expectedMethod.join(', ')); send(res, 405, { error: 'Method not allowed.' }); return; }
    if (req.method !== 'GET' && req.headers.origin !== config.WEB_ORIGIN) { send(res, 403, { error: 'Request origin is not allowed.' }); return; }
    if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) { send(res, 415, { error: 'Send application/json.' }); return; }
    if (path === '/api/register' || path === '/api/login') {
      // Only the private connector can reach production; Cloudflare supplies this client-IP header.
      const forwarded = req.headers['cf-connecting-ip'];
      const ip = config.NODE_ENV === 'production' && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress ?? 'unknown';
      if (activeAuth >= 2 || !authGlobal.allow('all') || !authIp.allow(ip)) {
        res.setHeader('Retry-After', '600'); send(res, 429, { error: 'Too many sign-in or registration attempts. Try again in 10 minutes.' }); return;
      }
      activeAuth++;
      try {
        const parsed = CredentialsSchema.safeParse(await readBody(req));
        if (!parsed.success) throw new AccountError('Use a valid email and a password of 12-128 characters.', 400);
        const user = path === '/api/register' ? await accounts.register(parsed.data.email, parsed.data.password) : await accounts.login(parsed.data.email, parsed.data.password);
        accounts.logout(token);
        cookie(res, accounts.createSession(user.id), 604800);
        send(res, path === '/api/register' ? 201 : 200, { user, aiReady: services.aiReady, emailVerificationEnabled: false });
      } finally { activeAuth--; }
      return;
    }
    if (path === '/api/logout') {
      const user = accounts.authenticate(token);
      accounts.logout(token);
      if (user) services.forgetUser(user.id);
      cookie(res, '', 0); send(res, 200, { ok: true }); return;
    }
    const user = accounts.authenticate(token);
    if (!user) throw new AccountError('Sign in or create an account to continue.', 401);
    if (path === '/api/account/key' || path === '/api/account/serpapi') {
      if (active >= 2 || !settingsRate.allow(user.id)) throw new AccountError('Too many account-setting requests. Try again in a minute.', 429);
      active++;
      try {
        let providerAccount: SerpApiAccount | undefined;
        if (req.method === 'DELETE') accounts.removeKey(user.id);
        else {
          let apiKey: string;
          if (req.method === 'PUT') {
            const parsed = SerpApiKeySchema.safeParse(await readBody(req));
            if (!parsed.success) throw new AccountError('Enter a valid SerpApi API key (20-256 characters, no whitespace).', 400);
            apiKey = parsed.data.apiKey;
          } else {
            const saved = accounts.getKey(user.id);
            if (!saved) throw new AccountError('Connect your SerpApi account first.', 409);
            apiKey = saved;
          }
          providerAccount = await services.verifyKey(apiKey, AbortSignal.timeout(20_000));
          if (req.method === 'PUT') accounts.saveKey(user.id, apiKey);
        }
        if (req.method !== 'GET') services.forgetUser(user.id);
        send(res, 200, { user: accounts.account(user.id), serpApiAccount: providerAccount ?? null });
      } catch (error) {
        if (error instanceof TrendsError) throw new AccountError(error.message, 502);
        throw error;
      } finally { active--; }
      return;
    }
    const apiKey = accounts.getKey(user.id);
    if (!apiKey) throw new AccountError('Add your own SerpApi key in account settings before searching.', 409);
    if (path === '/api/analyze' && !services.aiReady) throw new AccountError('AI is not configured on the server.', 503);
    if (active >= 2 || !globalRate.allow('all') || !userRate.allow(user.id)) {
      res.setHeader('Retry-After', '60'); send(res, 429, { error: 'The server is busy. Try again in a minute.' }); return;
    }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      const query = TrendQuerySchema.safeParse(await readBody(req));
      if (!query.success) throw new AccountError('Use 1-5 distinct terms (up to 100 characters each), a valid region, and a supported date range.', 400);
      if (path === '/api/analyze' && user.aiAttemptsToday >= user.aiDailyLimit) {
        throw new AccountError('Your daily AI allowance is used. It resets at midnight UTC.', 429);
      }
      const data = await services.trends(user.id, apiKey, query.data, controller.signal);
      if (path === '/api/trends') send(res, 200, data);
      else {
        accounts.consumeAiAttempt(user.id);
        send(res, 200, { analysis: await services.analyze(data, controller.signal), sourceUrl: data.sourceUrl, fetchedAt: data.fetchedAt, user: accounts.account(user.id) });
      }
    } catch (error) {
      if (error instanceof AccountError) throw error;
      logger.error('Trendalyse provider request failed', { path, error });
      if (!res.destroyed) send(res, 502, { error: error instanceof TrendsError ? error.message : 'AI analysis could not be completed. Try again later or contact support.' });
    } finally {
      clearTimeout(timer);
      res.off('close', abort);
      active--;
    }
  }
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof AccountError) {
        if (!res.headersSent && !res.destroyed) {
          if (error.status === 429) res.setHeader('Retry-After', '60');
          send(res, error.status, { error: error.message });
        }
        return;
      }
      logger.error('Web server request failed', { error });
      if (!res.headersSent && !res.destroyed) send(res, 500, { error: 'Server error.' });
      else res.destroy();
    });
  });
}

export async function startWebServer(): Promise<void> {
  const config = loadWebConfig();
  const logger = createLogger({ level: 'info', format: 'json' });
  const accounts = await openAccountStore(config.ACCOUNT_DATABASE_PATH, config.ACCOUNT_ENCRYPTION_KEY, config.AI_DAILY_LIMIT);
  let appConfig: ReturnType<typeof loadConfig> | undefined;
  if (process.env.DEEPSEEK_API_KEY) appConfig = loadConfig({ ...process.env, LLM_PROVIDER: 'deepseek', LLM_TIMEOUT_MS: process.env.LLM_TIMEOUT_MS?.trim() || '120000' });
  else logger.warn('AI is not configured; set DEEPSEEK_API_KEY on the server.');
  const clients = new Map<string, { fingerprint: string; client: TrendsClient }>();
  const server = createWebServer(config, {
    aiReady: Boolean(appConfig),
    verifyKey: (apiKey, signal) => new TrendsClient(apiKey).account(signal),
    forgetUser: (id) => { clients.delete(id); },
    trends: (userId, apiKey, query, signal) => {
      const fingerprint = createHash('sha256').update(apiKey).digest('hex');
      let entry = clients.get(userId);
      if (!entry || entry.fingerprint !== fingerprint) entry = { fingerprint, client: new TrendsClient(apiKey, globalThis.fetch, 10) };
      clients.delete(userId);
      if (clients.size >= 20) {
        const oldest = clients.keys().next().value;
        if (oldest !== undefined) clients.delete(oldest);
      }
      clients.set(userId, entry);
      return entry.client.get(query, signal);
    },
    analyze: (data, signal) => {
      if (!appConfig) throw new Error('DeepSeek is not configured.');
      return analyzeTrends(data, new LlmClient(appConfig, logger), appConfig, signal);
    },
  }, logger, accounts);
  server.on('close', () => accounts.close());
  server.on('error', (error) => { logger.error('Web server could not start', { error }); process.exitCode = 1; });
  server.listen(config.PORT, config.HOST, () => logger.info('Trendalyse listening', { host: config.HOST, port: config.PORT }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      const timer = setTimeout(() => server.closeAllConnections(), 10_000);
      timer.unref();
    });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void startWebServer().catch((error: unknown) => {
    createLogger({ level: 'error', format: 'json' }).error('Trendalyse startup failed', { error });
    process.exitCode = 1;
  });
}
