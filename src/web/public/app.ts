import type { TrendData, TrendQuery } from '../../trends/client.js';
import type { TrendAnalysis } from '../../trends/analyze.js';
import type { Account } from '../accounts.js';
import type { SerpApiAccount } from '../../trends/client.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
}
const form = element<HTMLFormElement>('search-form');
const terms = element<HTMLInputElement>('terms');
const geo = element<HTMLSelectElement>('geo');
const date = element<HTMLSelectElement>('date');
const searchButton = element<HTMLButtonElement>('search-button');
const analyzeButton = element<HTMLButtonElement>('analyze-button');
const status = element('status');
const aiStatus = element('ai-status');
const colors = ['#17634d', '#ce963f', '#6883c6', '#ad6291', '#62a2a0'];
let current: TrendData | undefined;
let aiReady = false;
let pending: AbortController | undefined;
let account: Account | null = null;
const accountStatus = element('account-status');
interface AccountResponse { user: Account | null; aiReady: boolean; emailVerificationEnabled: false }

function text(tag: string, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && account) {
      applyAccount(null);
    }
    throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status);
  }
  return data;
}
const api = <T>(path: string, body: TrendQuery, signal: AbortSignal) => request<T>(path, 'POST', body, signal);
function showError(target: HTMLElement, error: unknown): void {
  target.classList.add('error');
  target.textContent = error instanceof Error ? error.message : 'Request failed. Please try again.';
}
function showStep(step: number): void {
  for (const [index, id] of ['wizard-provider', 'wizard-connect', 'wizard-ready'].entries()) element(id).hidden = index + 1 !== step;
  const titles = ['Get your SerpApi key', 'Connect your data source', 'SerpApi is connected'];
  element('onboarding-title').textContent = titles[step - 1] ?? '';
  element('onboarding').classList.toggle('is-connected', step === 3);
  document.querySelectorAll<HTMLElement>('[data-step]').forEach((item) => {
    const number = Number(item.dataset.step);
    item.classList.toggle('complete', number < step);
    item.classList.toggle('active', number === step);
    if (number === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
}
function resetResearch(): void {
  pending?.abort();
  pending = undefined;
  current = undefined;
  element('results').hidden = true;
  element('empty-state').hidden = false;
  element('analysis').replaceChildren();
  status.textContent = '';
  aiStatus.textContent = '';
  searchButton.disabled = false;
  analyzeButton.disabled = true;
}
function applyAccount(user: Account | null, reset = false): void {
  if (user?.id !== account?.id || reset || !user?.hasSerpApiKey) {
    resetResearch();
    element('provider-quota').textContent = '';
  }
  account = user;
  element('dashboard-content').hidden = !user;
  element('dashboard-loading').hidden = Boolean(user);
  element('retry-account').hidden = true;
  if (!user) {
    window.location.replace('/login?expired=1');
    return;
  }
  element('account-email').textContent = user?.email ?? '';
  element('explorer').hidden = !user?.hasSerpApiKey;
  element('getting-started').hidden = !user.hasSerpApiKey;
  element('research-nav').hidden = !user.hasSerpApiKey;
  element('empty-state').hidden = !user.hasSerpApiKey || Boolean(current);
  element('setup-status').textContent = user.hasSerpApiKey ? 'Your data source is connected' : 'Next: connect your data source';
  element('provider-back').textContent = user.hasSerpApiKey ? 'Cancel replacement' : 'Back to key instructions';
  element<HTMLInputElement>('serpapi-key').value = '';
  element('connection-status').textContent = user?.hasSerpApiKey ? 'Your SerpApi key is connected and encrypted. Only your account can use it.' : '';
  element('ai-allowance').textContent = `${Math.max(0, user.aiDailyLimit - user.aiAttemptsToday)} of ${user.aiDailyLimit} AI attempts remaining today. Resets at midnight UTC.`;
  analyzeButton.disabled = !aiReady || !user || user.aiAttemptsToday >= user.aiDailyLimit;
  showStep(user.hasSerpApiKey ? 3 : 1);
}
function renderQuota(provider: SerpApiAccount): void {
  element('provider-quota').textContent = `${provider.planName}: ${provider.searchesRemaining} searches remaining; ${provider.monthUsage} used this month${provider.monthlyLimit === null ? '.' : ` out of ${provider.monthlyLimit}.`}`;
}
async function refreshAccount(): Promise<void> {
  const state = await request<AccountResponse>('/api/me');
  aiReady = state.aiReady;
  applyAccount(state.user);
}
function svgNode(tag: string, attributes: Record<string, string>): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
function render(data: TrendData): void {
  element('empty-state').hidden = true;
  element('results').hidden = false;
  element<HTMLAnchorElement>('source-link').href = data.sourceUrl;
  element('data-meta').textContent = `${data.source} | Fetched ${new Date(data.fetchedAt).toLocaleString()}.`;
  element('first-date').textContent = data.points[0]?.date ?? '';
  element('last-date').textContent = data.points.at(-1)?.date ?? '';
  const metrics = element('metrics');
  metrics.replaceChildren();
  for (const metric of data.metrics) {
    const card = text('div', '', 'metric');
    card.append(text('h3', metric.term), text('strong', String(metric.average)), text('span', ' / 100', 'muted'),
      text('p', `Latest complete period: ${metric.latest}`),
      text('p', metric.changePercent === null ? 'Change: insufficient baseline' : `${metric.changePercent > 0 ? '+' : ''}${metric.changePercent}% across selected range`));
    metrics.append(card);
  }
  const chart = document.getElementById('chart');
  if (!chart) throw new Error('Missing chart.');
  chart.replaceChildren();
  for (const level of [0, 25, 50, 75, 100]) {
    const y = 265 - level * 2.4;
    chart.append(svgNode('line', { x1: '40', x2: '945', y1: String(y), y2: String(y), stroke: '#e3e9df', 'stroke-dasharray': '4 5' }));
    const label = svgNode('text', { x: '5', y: String(y + 4), fill: '#697b73', 'font-size': '11' });
    label.textContent = String(level);
    chart.append(label);
  }
  data.query.terms.forEach((term, index) => {
    const coordinates = data.points.map((point, position) => `${40 + position / Math.max(1, data.points.length - 1) * 905},${265 - (point.values[index] ?? 0) * 2.4}`).join(' ');
    const line = svgNode('polyline', { points: coordinates, fill: 'none', stroke: colors[index] ?? colors[0] ?? '#17634d', 'stroke-width': '2.5', 'stroke-linejoin': 'round' });
    const title = svgNode('title', {});
    title.textContent = term;
    line.append(title);
    chart.append(line);
    const legend = svgNode('text', { x: String(40 + index * 180), y: '294', fill: colors[index] ?? '#17634d', 'font-size': '11' });
    legend.textContent = term.length > 24 ? `${term.slice(0, 21)}...` : term;
    chart.append(legend);
  });
  const table = element<HTMLTableElement>('data-table');
  table.replaceChildren();
  const heading = document.createElement('tr');
  for (const name of ['Period', ...data.query.terms, 'Partial']) heading.append(text('th', name));
  const thead = document.createElement('thead');
  thead.append(heading);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const point of data.points) {
    const row = document.createElement('tr');
    for (const value of [point.date, ...point.values.map(String), point.partial ? 'Yes' : 'No']) row.append(text('td', value));
    tbody.append(row);
  }
  table.append(tbody);
  element('related-term').textContent = `For "${data.relatedTerm}" only`;
  for (const kind of ['rising', 'top'] as const) {
    const container = element(kind);
    container.replaceChildren();
    if (!data.related[kind].length) container.append(text('p', 'No related queries available.', 'muted'));
    for (const query of data.related[kind]) {
      const row = text('div', '', 'query-row');
      row.append(text('span', query.query), text('strong', query.value));
      container.append(row);
    }
  }
  element('warnings').textContent = data.warnings.join(' ');
  analyzeButton.disabled = !aiReady || !account || account.aiAttemptsToday >= account.aiDailyLimit;
}
function renderAnalysis(analysis: TrendAnalysis): void {
  const container = element('analysis');
  container.replaceChildren();
  const cards = text('div', '', 'opportunities');
  for (const opportunity of analysis.opportunities) {
    const card = text('article', '', 'opportunity');
    card.append(text('h3', opportunity.title));
    for (const [label, value] of [['The idea', opportunity.pitch], ['The unexpected angle', opportunity.unconventionalAngle], ['Who it serves', opportunity.audience], ['Search evidence', opportunity.evidence], ['First experiment', opportunity.validation]]) {
      card.append(text('h4', label ?? ''), text('p', value ?? ''));
    }
    const challenges = text('details', '');
    challenges.append(text('summary', 'Assumptions and risks'),
      text('h4', 'The untested assumption'), text('p', opportunity.assumption),
      text('h4', 'What could make it fail'), text('p', opportunity.risk));
    card.append(challenges);
    cards.append(card);
  }
  if (analysis.opportunities.length) container.append(cards);
  else container.append(text('p', 'No sufficiently grounded ideas were generated. Try a more specific comparison or a different time range.', 'muted'));
  container.append(text('h3', 'The search context'), text('p', analysis.summary, 'insight-summary'), text('h3', 'Keep these limitations in mind'));
  const caveats = text('ul', '', 'caveats');
  for (const caveat of analysis.caveats) caveats.append(text('li', caveat));
  container.append(caveats);
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!account?.hasSerpApiKey) { showError(status, new Error('Sign in and connect your SerpApi key first.')); return; }
  const query = {
    terms: terms.value.split(',').map((value) => value.trim()).filter(Boolean),
    geo: geo.value, date: date.value,
  } as TrendQuery;
  if (!query.terms.length || query.terms.length > 5 || query.terms.some((term) => term.length > 100)) {
    showError(status, new Error('Enter 1-5 search terms, up to 100 characters each.'));
    return;
  }
  pending?.abort();
  pending = new AbortController();
  const controller = pending;
  current = undefined;
  element('results').hidden = true;
  element('analysis').replaceChildren();
  aiStatus.textContent = '';
  searchButton.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Fetching Google Trends data. This may take up to a minute...';
  void api<TrendData>('/api/trends', query, controller.signal).then((data) => {
    if (controller !== pending) return;
    current = data;
    render(data);
    status.textContent = 'Search signals loaded.';
  }).catch((error: unknown) => {
    if (!controller.signal.aborted) showError(status, error);
  }).finally(() => { if (controller === pending) searchButton.disabled = false; });
});
analyzeButton.addEventListener('click', () => {
  if (!current) return;
  pending?.abort();
  pending = new AbortController();
  const controller = pending;
  analyzeButton.disabled = true;
  aiStatus.classList.remove('error');
  aiStatus.textContent = 'DeepSeek is developing and challenging ideas from your search evidence. This may take a minute...';
  void api<{ analysis: TrendAnalysis; user: Account }>('/api/analyze', current.query, controller.signal).then((data) => {
    if (controller !== pending) return;
    renderAnalysis(data.analysis);
    applyAccount(data.user);
    aiStatus.textContent = 'Ideas generated. Test their assumptions before committing.';
  }).catch(async (error: unknown) => {
    if (!controller.signal.aborted) {
      showError(aiStatus, error);
      try { await refreshAccount(); } catch (refreshError) { showError(accountStatus, refreshError); }
    }
  }).finally(() => { if (controller === pending) analyzeButton.disabled = !aiReady || !account || account.aiAttemptsToday >= account.aiDailyLimit; });
});
document.querySelectorAll<HTMLButtonElement>('[data-terms]').forEach((button) => {
  button.addEventListener('click', () => { terms.value = button.dataset.terms ?? ''; terms.focus(); });
});
element('download').addEventListener('click', () => {
  if (!current) return;
  const escape = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? "'" : '') + value.replaceAll('"', '""')}"`;
  const rows = [['Period', ...current.query.terms, 'Partial'],
    ...current.points.map((point) => [point.date, ...point.values.map(String), String(point.partial)])];
  const url = URL.createObjectURL(new Blob([rows.map((row) => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'trendalyse-google-trends.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element('provider-next').addEventListener('click', () => { showStep(2); element<HTMLInputElement>('serpapi-key').focus(); });
element('provider-back').addEventListener('click', () => showStep(account?.hasSerpApiKey ? 3 : 1));
element('replace-key').addEventListener('click', () => { showStep(2); element<HTMLInputElement>('serpapi-key').focus(); });
element('paste-key').addEventListener('click', () => {
  if (!navigator.clipboard?.readText) {
    showError(accountStatus, new Error('Clipboard access is unavailable. Paste your key into the field manually.'));
    return;
  }
  void navigator.clipboard.readText().then((value) => {
    element<HTMLInputElement>('serpapi-key').value = value.trim();
    accountStatus.classList.remove('error');
    accountStatus.textContent = 'Key pasted. Select Verify & connect to save it securely.';
  }).catch(() => showError(accountStatus, new Error('Clipboard access is unavailable. Paste your key into the field manually.')));
});
element('key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = element<HTMLInputElement>('serpapi-key');
  const submit = element<HTMLButtonElement>('save-key');
  submit.disabled = true;
  accountStatus.classList.remove('error');
  accountStatus.textContent = 'Verifying your SerpApi account without using a search credit...';
  void request<{ user: Account; serpApiAccount: SerpApiAccount }>('/api/account/key', 'PUT', { apiKey: input.value.trim() }).then((state) => {
    applyAccount(state.user, true);
    renderQuota(state.serpApiAccount);
    accountStatus.textContent = 'SerpApi verified and connected. Your API key is encrypted.';
  }).catch((error: unknown) => showError(accountStatus, error)).finally(() => { input.value = ''; submit.disabled = false; });
});
element('refresh-quota').addEventListener('click', () => {
  const button = element<HTMLButtonElement>('refresh-quota');
  button.disabled = true;
  void request<{ serpApiAccount: SerpApiAccount }>('/api/account/serpapi').then((state) => {
    renderQuota(state.serpApiAccount);
    accountStatus.classList.remove('error');
    accountStatus.textContent = 'SerpApi quota refreshed without using a search credit.';
  }).catch((error: unknown) => showError(accountStatus, error)).finally(() => { button.disabled = false; });
});
element('remove-key').addEventListener('click', () => {
  const button = element<HTMLButtonElement>('remove-key');
  button.disabled = true;
  void request<{ user: Account }>('/api/account/key', 'DELETE', {}).then((state) => {
    applyAccount(state.user, true);
    element('provider-quota').textContent = '';
    accountStatus.textContent = 'SerpApi disconnected. The saved key has been removed.';
  }).catch((error: unknown) => showError(accountStatus, error)).finally(() => { button.disabled = false; });
});
element('logout-button').addEventListener('click', () => {
  const button = element<HTMLButtonElement>('logout-button');
  button.disabled = true;
  pending?.abort();
  void request('/api/logout', 'POST', {}).then(() => {
    resetResearch();
    account = null;
    element('dashboard-content').hidden = true;
    window.location.replace('/');
  }).catch((error: unknown) => showError(accountStatus, error)).finally(() => { button.disabled = false; });
});
element('start-exploring').addEventListener('click', () => {
  if (!terms.value) terms.value = 'meal prep,healthy snacks';
  element('explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  terms.focus();
});
async function loadDashboard(): Promise<void> {
  const retry = element<HTMLButtonElement>('retry-account');
  retry.disabled = true;
  try {
    await refreshAccount();
  } catch (error) {
    showError(element('dashboard-loading'), error);
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}
element('retry-account').addEventListener('click', () => { void loadDashboard(); });
void loadDashboard();
