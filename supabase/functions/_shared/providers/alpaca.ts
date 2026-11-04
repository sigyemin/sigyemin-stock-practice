// Alpaca — 미국 시세(IEX 무료). 시세 데이터 API 와 종목 정보(GET /v2/assets/{symbol}) 만.
// 근거: docs.alpaca.markets — StockSnapshots(GET data.alpaca.markets/v2/stocks/snapshots, feed=iex),
//       StockBars(GET /v2/stocks/bars, timeframe 1Min·1Day, limit 은 전체 합계, next_page_token),
//       Get an Asset(GET paper-api.alpaca.markets/v2/assets/{symbol_or_asset_id}).
// 주문·계좌·포지션 경로는 이 파일에 없다(paper-api 호스트도 assets 한 경로만 허용).
import { guardedFetch, type AllowRule, type FetchLike } from '../http.ts';
import type { Bar } from './kis.ts';

export const ALPACA_DATA = 'https://data.alpaca.markets';
export const ALPACA_PAPER = 'https://paper-api.alpaca.markets';

export const ALPACA_ALLOW: AllowRule[] = [
  { method: 'GET', origin: ALPACA_DATA, path: '/v2/stocks/snapshots' },
  { method: 'GET', origin: ALPACA_DATA, path: '/v2/stocks/bars' },
  { method: 'GET', origin: ALPACA_PAPER, path: /\/v2\/assets\/[A-Z][A-Z.]{0,9}/ },
];

export const US_SYMBOL = /^[A-Z][A-Z.]{0,9}$/;

export class AlpacaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AlpacaError';
    this.status = status;
  }
}

export type AlpacaDeps = { keyId: string; secretKey: string; fetch: FetchLike };

export function createAlpaca(deps: AlpacaDeps) {
  const f = guardedFetch(ALPACA_ALLOW, deps.fetch);
  const headers = { 'APCA-API-KEY-ID': deps.keyId, 'APCA-API-SECRET-KEY': deps.secretKey };

  async function get(url: string) {
    const res = await f(url, { method: 'GET', headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || body === null) throw new AlpacaError(res.status, 'alpaca error');
    return body;
  }

  return {
    async snapshots(symbols: string[]) {
      const q = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' });
      return parseSnapshots(await get(`${ALPACA_DATA}/v2/stocks/snapshots?${q}`));
    },
    // timeframe '1Min' | '1Day'. 페이지를 따라가되 maxPages 로 끊는다
    async bars(symbols: string[], timeframe: '1Min' | '1Day', start: string, maxPages = 5) {
      const out: Record<string, Bar[]> = {};
      let token: string | null = null;
      for (let i = 0; i < maxPages; i++) {
        const q = new URLSearchParams({ symbols: symbols.join(','), timeframe, start, feed: 'iex', limit: '10000', adjustment: 'raw' });
        if (token) q.set('page_token', token);
        const body = await get(`${ALPACA_DATA}/v2/stocks/bars?${q}`);
        for (const [sym, bars] of Object.entries(parseBars(body))) (out[sym] ??= []).push(...bars);
        token = typeof body.next_page_token === 'string' && body.next_page_token ? body.next_page_token : null;
        if (!token) break;
      }
      return out;
    },
    async asset(symbol: string) {
      if (!US_SYMBOL.test(symbol)) return null;
      try {
        return parseAsset(await get(`${ALPACA_PAPER}/v2/assets/${symbol}`));
      } catch (e) {
        if (e instanceof AlpacaError && e.status === 404) return null;
        throw e;
      }
    },
  };
}

const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function toBar(b: Record<string, unknown>): Bar | null {
  if (!b || typeof b.t !== 'string') return null;
  const o = n(b.o), h = n(b.h), l = n(b.l), c = n(b.c);
  if (o === null || h === null || l === null || c === null) return null;
  return { t: new Date(b.t).toISOString(), o, h, l, c, v: n(b.v) };
}

export function parseSnapshots(body: Record<string, Record<string, Record<string, unknown>>>) {
  const out: Record<string, { price: number; quote_at: string; open: number | null; high: number | null; low: number | null; volume: number | null; prev_close: number | null; daily_t: string | null }> = {};
  for (const [sym, s] of Object.entries(body ?? {})) {
    const trade = s?.latestTrade;
    const price = n(trade?.p);
    if (price === null || typeof trade?.t !== 'string') continue;
    const daily = s.dailyBar ?? {};
    out[sym] = {
      price,
      quote_at: new Date(trade.t as string).toISOString(),
      open: n(daily.o),
      high: n(daily.h),
      low: n(daily.l),
      volume: n(daily.v),
      prev_close: n(s.prevDailyBar?.c),
      daily_t: typeof daily.t === 'string' ? new Date(daily.t as string).toISOString() : null,
    };
  }
  return out;
}

export function parseBars(body: { bars?: Record<string, Record<string, unknown>[]> }) {
  const out: Record<string, Bar[]> = {};
  for (const [sym, list] of Object.entries(body?.bars ?? {})) {
    out[sym] = (list ?? []).map(toBar).filter((b): b is Bar => b !== null);
  }
  return out;
}

const EXCHANGE: Record<string, string> = {
  NYSE: 'NYSE',
  NASDAQ: 'NASDAQ',
  ARCA: 'NYSE_ARCA',
  NYSEARCA: 'NYSE_ARCA',
  AMEX: 'NYSE_AMERICAN',
};

export function parseAsset(a: Record<string, unknown>) {
  if (!a || a.class !== 'us_equity' || a.status !== 'active' || typeof a.symbol !== 'string') return null;
  const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : a.symbol;
  return {
    market: 'US',
    symbol: a.symbol,
    name,
    exchange: EXCHANGE[String(a.exchange)] ?? 'OTHER',
    currency: 'USD',
  } as const;
}
