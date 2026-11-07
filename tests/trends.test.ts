import { describe, expect, it, vi } from 'vitest';
import { TrendQuerySchema, TrendsClient, normalizeTimeline, trendMetrics } from '../src/trends/client.js';

const query = TrendQuerySchema.parse({ terms: ['coffee', 'matcha'] });
const timeline = {
  interest_over_time: { timeline_data: [
    { date: 'First', timestamp: '100', values: [{ query: 'matcha', extracted_value: 10 }, { query: 'coffee', extracted_value: 20 }] },
    { date: 'Last', timestamp: '200', values: [{ query: 'coffee', extracted_value: 40 }, { query: 'matcha', extracted_value: 0 }] },
    { date: 'Partial', timestamp: '300', isPartial: true, values: [{ query: 'coffee', extracted_value: 100 }, { query: 'matcha', extracted_value: 100 }] },
  ] },
};

describe('Google Trends data', () => {
  it('validates SerpApi through the free Account API without returning echoed credentials', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      account_status: 'Active', api_key: 'private-key', account_email: 'private@example.com',
      plan_name: 'Free', searches_per_month: 250, total_searches_left: 200, this_month_usage: 50,
    })));
    const result = await new TrendsClient('private-key', transport).account(new AbortController().signal);
    expect(result).toEqual({ planName: 'Free', monthlyLimit: 250, searchesRemaining: 200, monthUsage: 50 });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    const url = transport.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('Expected URL.');
    expect(url.pathname).toBe('/account.json');
  });
  it('validates query limits and duplicates', () => {
    for (const value of [
      { terms: [] }, { terms: ['x'.repeat(101)] }, { terms: ['a,b'] },
      { terms: ['coffee', 'COFFEE'] }, { terms: ['a'], geo: 'http://internal' },
      { terms: ['a'], date: 'anything' }, { terms: ['a'], url: 'http://internal' },
    ]) expect(TrendQuerySchema.safeParse(value).success).toBe(false);
    expect(TrendQuerySchema.parse({ terms: [' coffee '] }).terms).toEqual(['coffee']);
  });
  it('maps comparison values by query, preserves zero and omits partial metrics', () => {
    const points = normalizeTimeline(timeline, query);
    expect(points[0]?.values).toEqual([20, 10]);
    expect(points[1]?.values).toEqual([40, 0]);
    expect(trendMetrics(points, query.terms)).toEqual([
      { term: 'coffee', average: 30, latest: 40, changePercent: 100 },
      { term: 'matcha', average: 5, latest: 0, changePercent: -100 },
    ]);
  });
  it('does not invent growth when the baseline is zero or only one period exists', () => {
    const points = [{ date: 'a', timestamp: 0, partial: false, values: [0] }, { date: 'b', timestamp: 1, partial: false, values: [10] }];
    expect(trendMetrics(points, ['a'])[0]?.changePercent).toBeNull();
    expect(trendMetrics(points.slice(1), ['a'])[0]?.changePercent).toBeNull();
  });
  it('rejects missing, empty, and out-of-range data rather than fabricating a chart', () => {
    expect(() => normalizeTimeline({}, query)).toThrow(/no usable time series/);
    expect(() => normalizeTimeline({ interest_over_time: { timeline_data: [] } }, query)).toThrow();
    expect(() => normalizeTimeline(timeline, { ...query, terms: ['missing'] })).toThrow(/incomplete comparison/);
    expect(() => trendMetrics([], ['coffee'])).toThrow(/no complete periods/);
  });
  it('requests SerpApi with server-only credentials and caches successful queries', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(timeline)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ related_queries: { rising: [{ query: 'iced coffee', value: 'Breakout' }], top: [] } })));
    const client = new TrendsClient('private-serp-key', transport);
    const data = await client.get(query, new AbortController().signal);
    expect(data.sourceUrl).toContain('trends.google.com');
    expect(JSON.stringify(data)).not.toContain('private-serp-key');
    expect(data.relatedTerm).toBe('coffee');
    const input = transport.mock.calls[0]?.[0];
    if (!(input instanceof URL)) throw new Error('Expected a provider URL.');
    const url = input;
    expect(url.searchParams.get('q')).toBe('coffee,matcha');
    expect(url.searchParams.get('api_key')).toBe('private-serp-key');
    const relatedInput = transport.mock.calls[1]?.[0];
    if (!(relatedInput instanceof URL)) throw new Error('Expected a related-query URL.');
    expect(relatedInput.searchParams.get('q')).toBe('coffee');
    expect(await client.get(query, new AbortController().signal)).toBe(data);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('preserves usable charts with an explicit warning if related queries fail', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(timeline)))
      .mockResolvedValueOnce(new Response('quota', { status: 429 }));
    const data = await new TrendsClient('secret', transport).get(query, new AbortController().signal);
    expect(data.points).toHaveLength(3);
    expect(data.warnings[0]).toContain('429');
  });
  it('does not leak credential-bearing URLs or provider bodies on failures', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://serpapi.com?api_key=secret'));
    await expect(new TrendsClient('secret', transport).get(query, new AbortController().signal)).rejects.toThrow(/could not be reached/);
    transport.mockResolvedValue(new Response('api_key=secret', { status: 401 }));
    await expect(new TrendsClient('secret', transport).get(query, new AbortController().signal)).rejects.not.toThrow(/api_key=secret/);
  });
});
