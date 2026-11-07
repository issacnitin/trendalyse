import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { createWebServer, loadWebConfig, type WebServices } from '../src/web/server.js';
import { openAccountStore, type AccountStore } from '../src/web/accounts.js';
import { createLogger } from '../src/logger.js';
import { TrendsError, type TrendData } from '../src/trends/client.js';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const encryptionKey = 'a'.repeat(64);
const customerKey = 'customer-serpapi-key-123456789';
const password = 'correct horse battery staple';
let server: Server | undefined;
let store: AccountStore | undefined;
const data: TrendData = {
  query: { terms: ['coffee'], date: 'today 12-m', geo: '' },
  source: 'Google Trends via SerpApi', fetchedAt: '2026-01-01',
  sourceUrl: 'https://trends.google.com/trends/explore?q=coffee',
  points: [], metrics: [], related: { rising: [], top: [] }, relatedTerm: 'coffee', warnings: [],
};
const providerAccount = { planName: 'Free', monthlyLimit: 250, searchesRemaining: 250, monthUsage: 0 };
async function setup(overrides: Partial<WebServices> = {}, production = false) {
  const services: WebServices = {
    aiReady: true, trends: vi.fn().mockResolvedValue(data),
    analyze: vi.fn().mockResolvedValue({ summary: 'analysis' }),
    forgetUser: vi.fn(), verifyKey: vi.fn().mockResolvedValue(providerAccount), ...overrides,
  };
  store = await openAccountStore(':memory:', encryptionKey);
  server = createWebServer(loadWebConfig({
    NODE_ENV: production ? 'production' : 'test',
    ACCOUNT_ENCRYPTION_KEY: encryptionKey, WEB_ORIGIN: 'https://trendalyse.com',
  }), services, logger, store);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  const url = `http://127.0.0.1:${address.port}`;
  const send = (path: string, body: unknown = data.query, cookie = '', method = 'POST', headers: Record<string, string> = {}) =>
    fetch(url + path, { method, headers: { Origin: 'https://trendalyse.com', Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const register = async (email = 'person@example.com') => {
    const response = await send('/api/register', { email, password });
    expect(response.status).toBe(201);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('No login cookie issued.');
    return cookie;
  };
  return { services, url, send, register };
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    if (!server) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
  store?.close(); store = undefined;
});
describe.skipIf(Number(process.versions.node.split('.')[0]) < 22)('Trendalyse accounts server', () => {
  it('requires an encryption key and validates production HTTPS', () => {
    expect(() => loadWebConfig({ NODE_ENV: 'production' })).toThrow(/ACCOUNT_ENCRYPTION_KEY/);
    expect(() => loadWebConfig({ ACCOUNT_ENCRYPTION_KEY: encryptionKey, PORT: 'bad' })).toThrow();
    expect(() => loadWebConfig({ ACCOUNT_ENCRYPTION_KEY: encryptionKey, WEB_ORIGIN: 'https://trendalyse.com/' })).toThrow(/origin/);
    expect(() => loadWebConfig({ ACCOUNT_ENCRYPTION_KEY: encryptionKey, NODE_ENV: 'production' })).toThrow(/HTTPS/);
  });
  it('serves anonymous readiness without keys and requires registration/login', async () => {
    const { url, send } = await setup();
    const response = await fetch(url + '/api/status');
    expect(await response.json()).toEqual({ aiReady: true, authRequired: true, emailVerificationEnabled: false });
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await (await fetch(url + '/api/me')).json()).toMatchObject({ user: null });
    expect((await send('/api/trends')).status).toBe(401);
    expect((await send('/api/account/key', { apiKey: customerKey }, '', 'PUT')).status).toBe(401);
  });
  it('separates the public landing page and login page from the protected dashboard', async () => {
    const { url } = await setup();
    const landing = await (await fetch(url + '/')).text();
    expect(landing).toContain('<h1>Market research<br><span>using AI.</span></h1>');
    expect(landing).toContain('href="/login?mode=register"');
    expect(landing).not.toContain('id="account-form"');
    expect(landing).not.toContain('id="search-form"');
    expect(landing).not.toMatch(/src="\/app\.js(?:\?|")/);
    expect(landing).not.toContain('Your SerpApi key. Five AI attempts per day.');
    expect(landing).toContain('class="button-link how-button"');
    expect(landing).toContain('class="button-link sign-in-button"');
    expect(landing).toContain('<ul class="research-benefits">');
    expect(landing).not.toContain('class="simple-steps"');
    const login = await (await fetch(url + '/login')).text();
    expect(login).toContain('id="account-form"');
    expect(login).toMatch(/src="\/login\.js\?v=[a-f0-9]{16}"/);
    expect(login).not.toContain('id="key-form"');
    expect(login).not.toContain('id="search-form"');
    expect(login).not.toContain('class="auth-tabs"');
    expect(login).toContain('<label for="confirm-password">Confirm password</label>');
    expect(login).toContain('id="confirm-password" type="password"');
    expect(login).toContain('<a id="auth-switch" href="/login?mode=register">Create your account</a>');
    expect(login.indexOf('id="auth-switch"')).toBeGreaterThan(login.indexOf('id="account-submit"'));
    for (const method of ['GET', 'HEAD']) {
      const dashboard = await fetch(url + '/dashboard', { method, redirect: 'manual' });
      expect(dashboard.status).toBe(302);
      expect(dashboard.headers.get('location')).toBe('/login');
      expect(dashboard.headers.get('cache-control')).toBe('no-store');
      expect(dashboard.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(await dashboard.text()).toBe('');
    }
  });
  it('frames research around exploring ideas rather than only software', async () => {
    const { url, register } = await setup();
    const cookie = await register();
    for (const path of ['/', '/login', '/market-research-using-ai', '/dashboard']) {
      const html = await (await fetch(url + path, { headers: { Cookie: path === '/dashboard' ? cookie : '' } })).text();
      const copy = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
      expect(copy).not.toMatch(/\bsoftware\b|\bMVP\b/i);
      if (path === '/') expect(html).toContain('ideas worth testing');
      if (path === '/dashboard') {
        expect(html).toContain('data-terms="meal prep,healthy snacks"');
        expect(html).toContain('data-terms="guided tours,weekend getaways"');
        expect(html).toContain('data-terms="online courses,language learning"');
      }
    }
  });
  it('versions stylesheet and browser script URLs consistently across pages without changing asset access', async () => {
    const { url, register } = await setup();
    const landing = await (await fetch(url + '/')).text();
    const version = landing.match(/href="\/styles\.css\?v=([a-f0-9]{16})"/)?.[1];
    expect(version).toBeDefined();
    for (const path of ['/login', '/market-research-using-ai']) {
      const response = await fetch(url + path);
      const html = await response.text();
      expect(html).toContain(`href="/styles.css?v=${version}"`);
      if (path === '/login') {
        expect(html).toContain(`src="/login.js?v=${version}"`);
        expect(response.headers.get('cache-control')).toBe('no-store');
      } else {
        expect(html).toContain(`href="/research.css?v=${version}"`);
      }
    }
    const cookie = await register();
    const dashboard = await fetch(url + '/dashboard', { headers: { Cookie: cookie } });
    const html = await dashboard.text();
    expect(html).toContain(`href="/styles.css?v=${version}"`);
    expect(html).toContain(`src="/app.js?v=${version}"`);
    expect(dashboard.headers.get('cache-control')).toBe('no-store');
    for (const path of ['/styles.css', '/research.css']) {
      const plain = await fetch(url + path);
      const versioned = await fetch(`${url}${path}?v=${version}`);
      expect(versioned.status).toBe(200);
      expect(versioned.headers.get('content-type')).toBe('text/css; charset=utf-8');
      expect(versioned.headers.get('x-robots-tag')).toBeNull();
      expect(await versioned.text()).toBe(await plain.text());
      expect((await fetch(`${url}${path}?v=${version}`, { method: 'HEAD' })).status).toBe(200);
    }
    expect(await (await fetch(url + '/')).text()).toBe(landing);
  });
  it('serves readable public research content, canonical metadata, and matching structured data', async () => {
    const { url, services } = await setup();
    const response = await fetch(url + '/');
    expect(response.headers.get('x-robots-tag')).toBeNull();
    const landing = await response.text();
    expect(landing).toContain('<title>Market research using AI | Trendalyse</title>');
    expect(landing).toContain('<h1>Market research<br><span>using AI.</span></h1>');
    expect(landing).toContain('<link rel="canonical" href="https://trendalyse.com/">');
    expect(landing).toContain('property="og:url" content="https://trendalyse.com/"');
    expect(landing).toContain('name="twitter:card" content="summary"');
    expect(landing).toContain('href="/market-research-using-ai"');
    const block = landing.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(block).toBeDefined();
    const schema = JSON.parse(block ?? '') as {
      '@context': string;
      '@graph': Array<{ '@type': string; name: string; url: string; description?: string; featureList?: string[] }>;
    };
    expect(schema['@context']).toBe('https://schema.org');
    expect(schema['@graph'].map((entry) => entry['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication']);
    for (const entry of schema['@graph']) {
      expect(entry.name).toBe('Trendalyse');
      expect(entry.url).toBe('https://trendalyse.com/');
      expect(entry).not.toHaveProperty('aggregateRating');
      expect(entry).not.toHaveProperty('offers');
    }
    const application = schema['@graph'][2];
    expect(application?.description).toContain('does not establish purchase demand or product-market fit');
    expect(application?.featureList).toHaveLength(4);
    const hash = createHash('sha256').update(block ?? '').digest('base64');
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    const guideResponse = await fetch(url + '/market-research-using-ai');
    expect(guideResponse.status).toBe(200);
    expect(guideResponse.headers.get('x-robots-tag')).toBeNull();
    const guide = await guideResponse.text();
    expect(guide).toContain('<h1>Market research using AI</h1>');
    expect(guide).toContain('<link rel="canonical" href="https://trendalyse.com/market-research-using-ai">');
    expect(guide).toContain('relative interest from 0 to 100');
    expect(guide).toContain('not absolute search volumes');
    expect(guide).toContain('five attempts per account per UTC day');
    expect(guide).toContain('failed model attempts may count');
    expect(guide).toContain('customer interviews');
    expect(guide).not.toContain('id="search-form"');
    expect(guide).not.toContain('id="account-form"');
    expect(services.trends).not.toHaveBeenCalled();
    expect(services.analyze).not.toHaveBeenCalled();
  });
  it('serves public-only sitemap and shared crawler rules with correct GET and HEAD output', async () => {
    const { url } = await setup();
    const robotsResponse = await fetch(url + '/robots.txt');
    expect(robotsResponse.status).toBe(200);
    expect(robotsResponse.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const robots = await robotsResponse.text();
    const directives = robots.split('\n').filter((line) => line && !line.startsWith('#'));
    expect(directives).toEqual([
      'User-agent: *', 'User-agent: Googlebot', 'User-agent: OAI-SearchBot',
      'User-agent: Claude-SearchBot', 'User-agent: Claude-User',
      'Allow: /', 'Disallow: /dashboard', 'Disallow: /api/', 'Disallow: /healthz',
      'Sitemap: https://trendalyse.com/sitemap.xml',
    ]);
    const sitemapResponse = await fetch(url + '/sitemap.xml');
    expect(sitemapResponse.status).toBe(200);
    expect(sitemapResponse.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const sitemap = await sitemapResponse.text();
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locations).toEqual(['https://trendalyse.com/', 'https://trendalyse.com/market-research-using-ai']);
    expect(sitemap).not.toContain('<lastmod>');
    for (const location of locations) {
      const path = new URL(location ?? '').pathname;
      const response = await fetch(url + path, { headers: { 'User-Agent': 'OAI-SearchBot' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-robots-tag')).toBeNull();
      expect(await response.text()).toContain(`<link rel="canonical" href="${location}">`);
    }
    for (const path of ['/', '/market-research-using-ai', '/research.css', '/robots.txt', '/sitemap.xml']) {
      const get = await fetch(url + path);
      const head = await fetch(url + path, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(head.headers.get('content-security-policy')).toBe(get.headers.get('content-security-policy'));
      expect(head.headers.get('x-robots-tag')).toBeNull();
      expect(await head.text()).toBe('');
    }
  });
  it('keeps account, operational, and missing routes out of indexing regardless of user agent', async () => {
    const { url, register, send } = await setup();
    for (const path of ['/login?mode=register', '/api/status', '/api/me', '/healthz', '/missing', '/index.html']) {
      const response = await fetch(url + path);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    for (const agent of ['Googlebot', 'OAI-SearchBot', 'Claude-SearchBot', 'Claude-User', 'ChatGPT-User']) {
      const response = await fetch(url + '/dashboard', { headers: { 'User-Agent': agent }, redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/login');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    const denied = await send('/api/trends');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const invalidPublicMethod = await send('/');
    expect(invalidPublicMethod.status).toBe(404);
    expect(invalidPublicMethod.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const cookie = await register();
    for (const method of ['GET', 'HEAD']) {
      const dashboard = await fetch(url + '/dashboard', { method, headers: { Cookie: cookie } });
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(dashboard.headers.get('cache-control')).toBe('no-store');
      const login = await fetch(url + '/login', { method, headers: { Cookie: cookie }, redirect: 'manual' });
      expect(login.status).toBe(302);
      expect(login.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });
  it('sends authenticated customers to the dashboard and removes access after logout', async () => {
    const { url, register, send } = await setup();
    const cookie = await register();
    const headers = { Cookie: cookie };
    const dashboard = await fetch(url + '/dashboard', { headers });
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get('cache-control')).toBe('no-store');
    const content = await dashboard.text();
    expect(content).toContain('id="key-form"');
    expect(content).toContain('id="search-form"');
    expect(content).not.toContain('id="account-form"');
    const login = await fetch(url + '/login?mode=register', { headers, redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/dashboard');
    expect(await (await fetch(url + '/', { headers })).text()).toContain('<h1>Market research<br><span>using AI.</span></h1>');
    await send('/api/logout', {}, cookie);
    const loggedOut = await fetch(url + '/dashboard', { headers, redirect: 'manual' });
    expect(loggedOut.status).toBe(302);
    expect(loggedOut.headers.get('location')).toBe('/login');
  });
  it('uses host-only secure cookies in production and rotates sessions on login', async () => {
    const { send } = await setup({}, true);
    const response = await send('/api/register', { email: 'user@example.com', password });
    const fullCookie = response.headers.get('set-cookie') ?? '';
    expect(fullCookie).toContain('__Host-trendalyse-session=');
    expect(fullCookie).toContain('HttpOnly');
    expect(fullCookie).toContain('Secure');
    expect(fullCookie).toContain('SameSite=Lax');
    expect(fullCookie).not.toContain('Domain=');
    const oldCookie = fullCookie.split(';')[0] ?? '';
    const login = await send('/api/login', { email: 'user@example.com', password }, oldCookie);
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).not.toContain(oldCookie);
    expect((await send('/api/trends', data.query, oldCookie)).status).toBe(401);
  });
  it('serves three self-hosted illustrations without dense homepage feature grids', async () => {
    const { url } = await setup();
    const landing = await (await fetch(url + '/')).text();
    const sources = [...landing.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
    expect(sources).toEqual(['/images/research-map.svg', '/images/search-signals.svg', '/images/idea-validation.svg']);
    expect(landing).not.toContain('class="product-preview"');
    expect(landing).not.toContain('class="how-grid"');
    expect(landing).not.toContain('class="value-grid"');
    for (const path of sources) {
      const image = await fetch(url + path);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/svg+xml');
      expect(image.headers.get('x-robots-tag')).toBeNull();
      expect(await image.text()).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      const head = await fetch(url + path, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('image/svg+xml');
      expect(await head.text()).toBe('');
    }
  });
  it('validates auth input, origin, content type, body limits, and CSRF', async () => {
    const { services, send, url } = await setup();
    expect((await send('/api/register', { email: 'bad', password: 'short' })).status).toBe(400);
    expect((await send('/api/register', {}, '', 'POST', { Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await send('/api/login', {}, '', 'POST', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await fetch(url + '/api/register', { method: 'POST', headers: { Origin: 'https://trendalyse.com', 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await send('/api/register', { email: 'user@example.com', password: 'x'.repeat(5000) })).status).toBe(413);
    expect(services.trends).not.toHaveBeenCalled();
  });
  it('does not use an owner key and uses only the authenticated account credential', async () => {
    const { send, register, services } = await setup();
    const a = await register('alice@example.com');
    const b = await register('bob@example.com');
    expect((await send('/api/trends', data.query, a)).status).toBe(409);
    const saved = await send('/api/account/key', { apiKey: customerKey }, a, 'PUT');
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody.user).toMatchObject({ hasSerpApiKey: true, emailVerified: false });
    expect(savedBody.serpApiAccount).toEqual(providerAccount);
    expect(JSON.stringify(savedBody)).not.toContain(customerKey);
    expect(services.verifyKey).toHaveBeenCalledWith(customerKey, expect.any(AbortSignal));
    expect((await send('/api/trends', data.query, b)).status).toBe(409);
    expect((await send('/api/trends', data.query, a)).status).toBe(200);
    expect(services.trends).toHaveBeenCalledWith(savedBody.user.id, customerKey, data.query, expect.any(AbortSignal));
    expect((await send('/api/analyze', { ...data.query, userId: savedBody.user.id }, b)).status).toBe(409);
    expect((await send('/api/analyze', { ...data.query, points: [] }, a)).status).toBe(400);
  });
  it('keeps the previous key when verification fails and removes it on disconnect', async () => {
    const { send, register, services } = await setup();
    const cookie = await register();
    await send('/api/account/key', { apiKey: customerKey }, cookie, 'PUT');
    vi.mocked(services.verifyKey).mockRejectedValueOnce(new TrendsError('Invalid SerpApi key.'));
    expect((await send('/api/account/key', { apiKey: 'another-long-serpapi-key' }, cookie, 'PUT')).status).toBe(502);
    await send('/api/trends', data.query, cookie);
    expect(services.trends).toHaveBeenLastCalledWith(expect.any(String), customerKey, data.query, expect.any(AbortSignal));
    expect((await send('/api/account/key', {}, cookie, 'DELETE')).status).toBe(200);
    expect((await send('/api/trends', data.query, cookie)).status).toBe(409);
    expect(services.forgetUser).toHaveBeenCalled();
  });
  it('enforces five daily AI attempts without taking a sixth provider call', async () => {
    const { send, register, services } = await setup();
    const cookie = await register();
    await send('/api/account/key', { apiKey: customerKey }, cookie, 'PUT');
    for (let i = 0; i < 5; i++) expect((await send('/api/analyze', data.query, cookie)).status).toBe(200);
    const sixth = await send('/api/analyze', data.query, cookie);
    expect(sixth.status).toBe(429);
    expect(services.analyze).toHaveBeenCalledTimes(5);
    expect(services.trends).toHaveBeenCalledTimes(5);
  });
  it('logs out and stops the old cookie from reading or modifying credentials', async () => {
    const { url, send, register } = await setup();
    const cookie = await register();
    expect((await send('/api/logout', {}, cookie)).status).toBe(200);
    expect(await (await fetch(url + '/api/me', { headers: { Cookie: cookie } })).json()).toMatchObject({ user: null });
    expect((await send('/api/account/key', { apiKey: customerKey }, cookie, 'PUT')).status).toBe(401);
  });
  it('uses generic login errors and limits brute-force attempts', async () => {
    const { send } = await setup();
    for (let i = 0; i < 10; i++) {
      const response = await send('/api/login', { email: 'missing@example.com', password });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Email or password is incorrect.' });
    }
    expect((await send('/api/login', { email: 'missing@example.com', password })).status).toBe(429);
  });
});
