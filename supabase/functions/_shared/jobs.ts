// 예약 실행 작업의 본문(순수 로직). DB·공급자는 deps 로 받는다 → 실제 키 없이 합성 응답으로 시험.
import { isKrxOpen, isNyseOpen, KR_TZ, US_TZ, localDate, localHhmmss, type CalendarRow } from './market-time.ts';
import { krPlan, parseKrMode } from './providers/index.ts';
import type { createKis, Bar } from './providers/kis.ts';
import { kstToIso } from './providers/kis.ts';
import type { createAlpaca } from './providers/alpaca.ts';
import type { createExim } from './providers/koreaexim.ts';

export type Kis = ReturnType<typeof createKis>;
export type Alpaca = ReturnType<typeof createAlpaca>;
export type Exim = ReturnType<typeof createExim>;

export type QuoteRow = {
  market: 'KR' | 'US';
  symbol: string;
  price: number;
  prev_close?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  base_price?: number | null;
  upper_limit?: number | null;
  lower_limit?: number | null;
  mode: 'realtime' | 'delayed';
  quote_at: string;
  source: string;
};
export type CandleRow = Bar & { market: 'KR' | 'US'; symbol: string; tf: '1m' | '5m' | '1d'; source: string };

export type JobDb = {
  settings: () => Promise<Record<string, string>>;
  calendar: (market: 'KR' | 'US', date: string) => Promise<CalendarRow>;
  watchSymbols: (market: 'KR' | 'US', limit: number) => Promise<string[]>;
  saveQuotes: (rows: QuoteRow[]) => Promise<void>;
  saveCandles: (rows: CandleRow[]) => Promise<void>;
  saveFx: (date: string, usdkrw: number, source: string) => Promise<void>;
  saveCalendar: (rows: { market: 'KR' | 'US'; trade_date: string; is_open: boolean; source_url: string }[]) => Promise<void>;
};

export type JobResult = { status: 'ok' | 'skipped' | 'error'; reason?: string; count?: number; errors?: string[] };

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
};

const errCode = (e: unknown) => {
  const o = e as { name?: string; code?: string; status?: number };
  return `${o?.name ?? 'Error'}:${o?.code ?? o?.status ?? ''}`;
};

const toCandles = (market: 'KR' | 'US', symbol: string, tf: CandleRow['tf'], source: string, bars: Bar[]): CandleRow[] =>
  bars.map((b) => ({ ...b, market, symbol, tf, source }));

// 봉 값이 일관되지 않으면(고가<저가 등) 버린다 — DB check 제약에 막혀 한 묶음 전체가 실패하지 않게
export const saneBar = (b: Bar) => b.h >= b.l && b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c && b.l > 0;

// ───────── tick-kr: KIS 실시간 모드에서만 ─────────
export async function runTickKr(d: {
  db: JobDb;
  kis: Kis | null;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}): Promise<JobResult> {
  const s = await d.db.settings();
  const plan = krPlan(parseKrMode(s.kr_quote_mode));
  if (plan.provider !== 'kis') return { status: 'skipped', reason: 'mode_delayed' };
  const start = d.now();
  const cal = await d.db.calendar('KR', localDate(KR_TZ, start));
  if (!isKrxOpen(start, cal, 5)) return { status: 'skipped', reason: 'market_closed' };
  if (!d.kis) return { status: 'error', reason: 'kis_not_configured' };

  const symbols = await d.db.watchSymbols('KR', int(s.tick_max_symbols_kr, 20));
  const budget = int(s.tick_time_budget_ms, 100000);
  const gap = int(s.kis_call_gap_ms, 70);
  const quotes: QuoteRow[] = [];
  const candles: CandleRow[] = [];
  const errors: string[] = [];
  for (const sym of symbols) {
    if (d.now().getTime() - start.getTime() > budget) {
      errors.push('time_budget');
      break;
    }
    try {
      const p = await d.kis.price(sym);
      const at = d.now().toISOString();
      quotes.push({ market: 'KR', symbol: sym, ...p, mode: 'realtime', quote_at: at, source: 'kis' });
      if (p.open !== null && p.high !== null && p.low !== null) {
        const day: Bar = { t: kstToIso(localDate(KR_TZ, start).replace(/-/g, '')), o: p.open, h: p.high, l: p.low, c: p.price, v: p.volume };
        if (saneBar(day)) candles.push(...toCandles('KR', sym, '1d', 'kis', [day]));
      }
      await d.sleep(gap);
      const bars = await d.kis.minuteBars(sym, localHhmmss(KR_TZ, d.now()));
      candles.push(...toCandles('KR', sym, '1m', 'kis', bars.filter(saneBar)));
      await d.sleep(gap);
    } catch (e) {
      errors.push(`${sym}:${errCode(e)}`);
    }
  }
  if (quotes.length) await d.db.saveQuotes(quotes);
  if (candles.length) await d.db.saveCandles(candles);
  return { status: 'ok', count: quotes.length, errors };
}

// ───────── tick-us: Alpaca(IEX) ─────────
export async function runTickUs(d: { db: JobDb; alpaca: Alpaca | null; now: () => Date }): Promise<JobResult> {
  const s = await d.db.settings();
  const now = d.now();
  const cal = await d.db.calendar('US', localDate(US_TZ, now));
  if (!isNyseOpen(now, cal, 5)) return { status: 'skipped', reason: 'market_closed' };
  if (!d.alpaca) return { status: 'error', reason: 'alpaca_not_configured' };
  const symbols = await d.db.watchSymbols('US', int(s.tick_max_symbols_us, 30));
  if (symbols.length === 0) return { status: 'ok', count: 0, errors: [] };

  const errors: string[] = [];
  const quotes: QuoteRow[] = [];
  const candles: CandleRow[] = [];
  try {
    const snaps = await d.alpaca.snapshots(symbols);
    for (const [sym, q] of Object.entries(snaps)) {
      if (!symbols.includes(sym)) continue;
      quotes.push({ market: 'US', symbol: sym, price: q.price, prev_close: q.prev_close, open: q.open, high: q.high, low: q.low, volume: q.volume, mode: 'realtime', quote_at: q.quote_at, source: 'alpaca_iex' });
      if (q.daily_t && q.open !== null && q.high !== null && q.low !== null) {
        const day: Bar = { t: q.daily_t, o: q.open, h: Math.max(q.high, q.price), l: Math.min(q.low, q.price), c: q.price, v: q.volume };
        if (saneBar(day)) candles.push(...toCandles('US', sym, '1d', 'alpaca_iex', [day]));
      }
    }
  } catch (e) {
    errors.push(`snapshots:${errCode(e)}`);
  }
  try {
    const since = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const bars = await d.alpaca.bars(symbols, '1Min', since, 2);
    for (const [sym, list] of Object.entries(bars)) {
      if (symbols.includes(sym)) candles.push(...toCandles('US', sym, '1m', 'alpaca_iex', list.filter(saneBar)));
    }
  } catch (e) {
    errors.push(`bars:${errCode(e)}`);
  }
  if (quotes.length) await d.db.saveQuotes(quotes);
  if (candles.length) await d.db.saveCandles(candles);
  return { status: 'ok', count: quotes.length, errors };
}

// ───────── fx-sync: 수출입은행 매매기준율(없으면 저장하지 않음 → 읽는 쪽이 직전 고시값 사용) ─────────
export async function runFxSync(d: { db: JobDb; exim: Exim | null; now: () => Date }): Promise<JobResult> {
  if (!d.exim) return { status: 'error', reason: 'koreaexim_not_configured' };
  const date = localDate(KR_TZ, d.now());
  const rate = await d.exim.usdkrw(date.replace(/-/g, ''));
  if (rate === null) return { status: 'skipped', reason: 'no_rate_yet' };
  await d.db.saveFx(date, rate, 'koreaexim');
  return { status: 'ok', count: 1 };
}

// ───────── ref-sync: 한국 휴장일(KIS chk-holiday, 하루 1회 이하) ─────────
export async function runRefSync(d: { db: JobDb; kis: Kis | null; now: () => Date }): Promise<JobResult> {
  if (!d.kis) return { status: 'error', reason: 'kis_not_configured' };
  const rows = await d.kis.holidays(localDate(KR_TZ, d.now()).replace(/-/g, ''));
  await d.db.saveCalendar(rows.map((r) => ({ market: 'KR', ...r, source_url: 'kis:chk-holiday' })));
  return { status: 'ok', count: rows.length };
}

// ───────── 종목 추가(instrument-lookup): 종목 정보 + 일봉 기록 받아 오기 ─────────
export const KR_SYMBOL = /^[0-9]{6}$/;

export async function backfillDaily(d: {
  market: 'KR' | 'US';
  symbol: string;
  days: number;
  kis: Kis | null;
  alpaca: Alpaca | null;
  now: () => Date;
}): Promise<CandleRow[]> {
  const now = d.now();
  const from = new Date(now.getTime() - d.days * 86400000);
  if (d.market === 'US') {
    if (!d.alpaca) return [];
    const bars = await d.alpaca.bars([d.symbol], '1Day', from.toISOString().slice(0, 10), 3);
    return toCandles('US', d.symbol, '1d', 'alpaca_iex', (bars[d.symbol] ?? []).filter(saneBar));
  }
  if (!d.kis) return [];
  // KIS 일봉은 1회 최대 100건 → 끝에서부터 100일 단위로 거슬러 올라간다(최대 5번)
  const out: Bar[] = [];
  let to = localDate(KR_TZ, now).replace(/-/g, '');
  const stop = localDate(KR_TZ, from).replace(/-/g, '');
  for (let i = 0; i < 5 && to >= stop; i++) {
    const bars = await d.kis.dailyBars(d.symbol, stop, to);
    if (bars.length === 0) break;
    out.push(...bars);
    const first = bars[0].t; // 가장 이른 봉(ISO, 한국 00:00)
    const prev = new Date(Date.parse(first) - 86400000);
    to = localDate(KR_TZ, prev).replace(/-/g, '');
  }
  const uniq = new Map(out.map((b) => [b.t, b]));
  return toCandles('KR', d.symbol, '1d', 'kis', [...uniq.values()].filter(saneBar).sort((a, b) => a.t.localeCompare(b.t)));
}
