import { PollPage } from './schemas.js';

// HTTP client for the vendor poll API. It never throws for vendor behaviour:
// every response is classified so the poller can decide what to do.
export type PageResult =
  | { kind: 'ok'; status: number; page: PollPage; raw: unknown }
  | { kind: 'rate_limited'; status: 429; retryAfterSec: number }
  | { kind: 'server_error'; status: number; requestId: string | null; body: string }
  | { kind: 'client_error'; status: number; body: string }
  | { kind: 'invalid_page'; status: number; reason: string; body: string }
  | { kind: 'timeout' }
  | { kind: 'network_error'; message: string };

export interface PageQuery {
  siteId: string;
  since: Date | null;
  cursor: string | null;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class CsmsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly timeoutMs = 10_000,
    private readonly apiToken: string | null = null,
  ) {}

  path(q: PageQuery): string {
    const params = new URLSearchParams({ site_id: q.siteId });
    if (q.since) params.set('since', q.since.toISOString());
    if (q.cursor) params.set('cursor', q.cursor);
    return `/v1/chargers?${params.toString()}`;
  }

  async fetchPage(q: PageQuery): Promise<PageResult> {
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + this.path(q), {
        headers: this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { kind: 'timeout' };
      return { kind: 'network_error', message: e.message };
    }

    const body = await res.text().catch(() => '');
    if (res.status === 429) {
      return { kind: 'rate_limited', status: 429, retryAfterSec: retryAfterSeconds(res.headers.get('retry-after'), body) };
    }
    if (res.status >= 500) {
      return { kind: 'server_error', status: res.status, requestId: jsonField(body, 'request_id'), body };
    }
    if (res.status >= 400) return { kind: 'client_error', status: res.status, body };

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { kind: 'invalid_page', status: res.status, reason: 'body is not valid JSON', body };
    }
    const parsed = PollPage.safeParse(json);
    if (!parsed.success) {
      const reason = parsed.error.issues.map((i) => `${i.path.join('.') || 'page'}: ${i.message}`).join('; ');
      return { kind: 'invalid_page', status: res.status, reason, body };
    }
    if (parsed.data.site_id !== q.siteId) {
      return { kind: 'invalid_page', status: res.status, reason: `page is for site ${parsed.data.site_id}`, body };
    }
    return { kind: 'ok', status: res.status, page: parsed.data, raw: json };
  }
}

// Retry-After may be delta-seconds or an HTTP date; the vendor also puts
// retry_after_seconds in the body. Default to the documented 30 s.
export function retryAfterSeconds(header: string | null, body: string, now = new Date()): number {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return secs;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
  }
  const fromBody = Number(jsonField(body, 'retry_after_seconds'));
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  return 30;
}

function jsonField(body: string, field: string): string | null {
  try {
    const v = (JSON.parse(body) as Record<string, unknown>)[field];
    return v === undefined || v === null ? null : String(v);
  } catch {
    return null;
  }
}
