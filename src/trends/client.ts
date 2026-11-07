import { z } from 'zod';

export const TrendQuerySchema = z.object({
  terms: z.array(z.string().trim().min(1).max(100).regex(/^[^,\r\n]+$/)).min(1).max(5),
  geo: z.string().regex(/^(?:[A-Z]{2}(?:-[A-Z0-9]{1,3})?)?$/).default(''),
  date: z.enum(['now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y'])
    .default('today 12-m'),
}).strict().refine((query) => new Set(query.terms.map((term) => term.toLowerCase())).size === query.terms.length,
  'Use distinct search terms.');
export type TrendQuery = z.infer<typeof TrendQuerySchema>;

const TimelineSchema = z.object({
  interest_over_time: z.object({
    timeline_data: z.array(z.object({
      date: z.string().max(100),
      timestamp: z.string().regex(/^\d{1,11}$/),
      isPartial: z.boolean().optional(),
      values: z.array(z.object({
        query: z.string().max(100),
        extracted_value: z.number().min(0).max(100),
      })).min(1).max(5),
    })).min(1).max(2000),
  }),
});
const RelatedSchema = z.object({
  related_queries: z.object({
    rising: z.array(z.object({ query: z.string().max(200), value: z.string().max(80) })).max(100).optional(),
    top: z.array(z.object({ query: z.string().max(200), value: z.string().max(80) })).max(100).optional(),
  }),
});

export interface TrendPoint {
  date: string;
  timestamp: number;
  partial: boolean;
  values: number[];
}
export interface TrendData {
  query: TrendQuery;
  source: 'Google Trends via SerpApi';
  fetchedAt: string;
  sourceUrl: string;
  points: TrendPoint[];
  metrics: { term: string; average: number; latest: number; changePercent: number | null }[];
  related: { rising: { query: string; value: string }[]; top: { query: string; value: string }[] };
  relatedTerm: string;
  warnings: string[];
}

export class TrendsError extends Error {}
const SerpApiAccountSchema = z.object({
  account_status: z.string(),
  plan_name: z.string().min(1).max(100),
  searches_per_month: z.number().nonnegative().nullable(),
  total_searches_left: z.number().nonnegative(),
  this_month_usage: z.number().nonnegative(),
});
export interface SerpApiAccount {
  planName: string;
  monthlyLimit: number | null;
  searchesRemaining: number;
  monthUsage: number;
}

export function normalizeTimeline(raw: unknown, query: TrendQuery): TrendPoint[] {
  const parsed = TimelineSchema.safeParse(raw);
  if (!parsed.success) throw new TrendsError('Google Trends returned no usable time series. Try a broader term or date range.');
  return parsed.data.interest_over_time.timeline_data.map((point) => {
    const values = query.terms.map((term) => {
      const value = point.values.find((entry) => entry.query === term);
      if (!value) throw new TrendsError('Google Trends returned an incomplete comparison.');
      return value.extracted_value;
    });
    return {
      date: point.date,
      timestamp: Number(point.timestamp) * 1000,
      partial: point.isPartial ?? false,
      values,
    };
  }).sort((a, b) => a.timestamp - b.timestamp);
}

export function trendMetrics(points: TrendPoint[], terms: string[]): TrendData['metrics'] {
  const complete = points.filter((point) => !point.partial);
  if (!complete.length) throw new TrendsError('Google Trends has no complete periods for this request.');
  return terms.map((term, index) => {
    const values = complete.map((point) => {
      const value = point.values[index];
      if (value === undefined) throw new TrendsError('Google Trends returned an incomplete comparison.');
      return value;
    });
    const average = (items: number[]) => items.reduce((sum, value) => sum + value, 0) / items.length;
    const window = Math.max(1, Math.floor(values.length / 4));
    const first = average(values.slice(0, window));
    const last = average(values.slice(-window));
    const latest = values.at(-1);
    if (latest === undefined) throw new TrendsError('Google Trends has no complete periods for this request.');
    return {
      term,
      average: Math.round(average(values) * 10) / 10,
      latest,
      changePercent: values.length < 2 || first === 0 ? null : Math.round((last - first) / first * 1000) / 10,
    };
  });
}

export class TrendsClient {
  private readonly cache = new Map<string, { expires: number; data: TrendData }>();

  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = globalThis.fetch,
    private readonly cacheLimit = 100,
  ) {}

  async account(signal: AbortSignal): Promise<SerpApiAccount> {
    const url = new URL('https://serpapi.com/account.json');
    url.searchParams.set('api_key', this.apiKey);
    const raw = await this.read(url, signal);
    const parsed = SerpApiAccountSchema.safeParse(raw);
    if (!parsed.success) throw new TrendsError('SerpApi returned an invalid account response. The connection could not be verified.');
    if (parsed.data.account_status.toLowerCase() !== 'active') throw new TrendsError('Your SerpApi account is not active. Check its status in the SerpApi dashboard.');
    // The provider response includes api_key; only these non-secret fields may leave this boundary.
    return {
      planName: parsed.data.plan_name, monthlyLimit: parsed.data.searches_per_month,
      searchesRemaining: parsed.data.total_searches_left, monthUsage: parsed.data.this_month_usage,
    };
  }

  private async request(query: TrendQuery, type: string, signal: AbortSignal): Promise<unknown> {
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({
      engine: 'google_trends', api_key: this.apiKey,
      q: type === 'RELATED_QUERIES' ? query.terms[0] ?? '' : query.terms.join(','),
      geo: query.geo, date: query.date, data_type: type, hl: 'en', tz: '0',
    }).toString();
    return this.read(url, signal);
  }

  private async read(url: URL, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) });
    } catch {
      // Never propagate fetch errors containing the credential-bearing URL.
      throw new TrendsError(signal.aborted ? 'Trend request cancelled.' : 'Google Trends provider timed out or could not be reached.');
    }
    if (!response.ok) throw new TrendsError(`Google Trends provider returned HTTP ${response.status}. Check your saved SerpApi key and account quota.`);
    try {
      const raw: unknown = await response.json();
      if (typeof raw === 'object' && raw !== null && 'error' in raw) {
        throw new TrendsError('Google Trends provider could not complete this search. Check the query and SerpApi quota.');
      }
      return raw;
    } catch (error) {
      if (error instanceof TrendsError) throw error;
      throw new TrendsError('Google Trends provider returned an invalid response.');
    }
  }

  async get(query: TrendQuery, signal: AbortSignal): Promise<TrendData> {
    const key = JSON.stringify(query);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    const points = normalizeTimeline(await this.request(query, 'TIMESERIES', signal), query);
    const warnings: string[] = [];
    let related: TrendData['related'] = { rising: [], top: [] };
    try {
      const parsed = RelatedSchema.safeParse(await this.request(query, 'RELATED_QUERIES', signal));
      if (!parsed.success) throw new TrendsError('Related queries are not available for this search.');
      related = { rising: parsed.data.related_queries.rising?.slice(0, 10) ?? [], top: parsed.data.related_queries.top?.slice(0, 10) ?? [] };
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push(error instanceof TrendsError ? error.message : 'Related queries could not be loaded.');
    }
    const sourceUrl = new URL('https://trends.google.com/trends/explore');
    sourceUrl.search = new URLSearchParams({ q: query.terms.join(','), geo: query.geo, date: query.date }).toString();
    const data: TrendData = {
      query, source: 'Google Trends via SerpApi', fetchedAt: new Date().toISOString(),
      sourceUrl: sourceUrl.toString(), points, metrics: trendMetrics(points, query.terms),
      related, relatedTerm: query.terms[0] ?? '', warnings,
    };
    if (this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { expires: Date.now() + 3_600_000, data });
    return data;
  }
}
