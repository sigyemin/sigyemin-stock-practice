// 예약 실행 작업의 본문(순수 로직). DB·공급자는 deps 로 받는다 → 실제 키 없이 합성 응답으로 시험.
import { isKrxOpen, isNyseOpen, KR_TZ, US_TZ, localDate, localHhmmss, type CalendarRow } from './market-time.ts';
import { krPlan, parseKrMode } from './providers/index.ts';
import type { createKis, Bar } from './providers/kis.ts';
import { kstToIso, type DividendRow } from './providers/kis.ts';
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
  // 주문 처리(M3): DB 함수 sp.process_orders / sp.expire_orders
  processOrders: (market: 'KR' | 'US') => Promise<number>;
  expireOrders: (market: 'KR' | 'US') => Promise<number>;
  // M4: 배당 일정 대상(보유 + 관심 종목), 일정 저장(sp.upsert_dividend_events), 마감·연간 정산
  dividendSymbols: (market: 'KR' | 'US', limit: number) => Promise<string[]>;
  upsertDividendEvents: (rows: DividendRow[]) => Promise<number>;
  dailyClose: () => Promise<Record<string, number>>;
  taxAnnual: () => Promise<Record<string, number>>;
};

export type JobResult = { status: 'ok' | 'skipped' | 'error'; reason?: string; count?: number; errors?: string[]; filled?: number; expired?: number; [k: string]: unknown };

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
  // 수집을 건너뛰더라도 지난 주문의 당일 만료는 한다(묶인 돈이 남지 않게, 리뷰 SP-028 M2)
  if (plan.provider !== 'kis') return { status: 'skipped', reason: 'mode_delayed', ...(await expireOnly(d.db, 'KR')) };
  const start = d.now();
  const cal = await d.db.calendar('KR', localDate(KR_TZ, start));
  if (!isKrxOpen(start, cal, 5)) return { status: 'skipped', reason: 'market_closed', ...(await expireOnly(d.db, 'KR')) };
  if (!d.kis) return { status: 'error', reason: 'kis_not_configured', ...(await expireOnly(d.db, 'KR')) };

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
  const orders = await settleOrders(d.db, 'KR', isKrxOpen(d.now(), cal, 0), errors);
  return { status: 'ok', count: quotes.length, errors, ...orders };
}

// 수집하지 않는 실행에서도: 마감이 지난 1m 주문 만료(장중 주문은 건드리지 않는 DB 함수)
async function expireOnly(db: JobDb, market: 'KR' | 'US') {
  try {
    return { expired: await db.expireOrders(market) };
  } catch {
    return { expired: 0, errors: ['orders:expire'] };
  }
}

// 시세·봉 저장 뒤: 대기·예약 주문 처리, 정규장이 끝났으면 당일 만료
async function settleOrders(db: JobDb, market: 'KR' | 'US', stillOpen: boolean, errors: string[]) {
  let filled = 0;
  let expired = 0;
  try {
    filled = await db.processOrders(market);
    if (!stillOpen) expired = await db.expireOrders(market);
  } catch (e) {
    errors.push(`orders:${errCode(e)}`);
  }
  return { filled, expired };
}

// ───────── tick-us: Alpaca(IEX) ─────────
export async function runTickUs(d: { db: JobDb; alpaca: Alpaca | null; now: () => Date }): Promise<JobResult> {
  const s = await d.db.settings();
  const now = d.now();
  const cal = await d.db.calendar('US', localDate(US_TZ, now));
  if (!isNyseOpen(now, cal, 5)) return { status: 'skipped', reason: 'market_closed', ...(await expireOnly(d.db, 'US')) };
  if (!d.alpaca) return { status: 'error', reason: 'alpaca_not_configured', ...(await expireOnly(d.db, 'US')) };
  const symbols = await d.db.watchSymbols('US', int(s.tick_max_symbols_us, 30));
  if (symbols.length === 0) {
    const errors: string[] = [];
    return { status: 'ok', count: 0, errors, ...(await settleOrders(d.db, 'US', isNyseOpen(d.now(), cal, 0), errors)) };
  }

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
  const orders = await settleOrders(d.db, 'US', isNyseOpen(d.now(), cal, 0), errors);
  return { status: 'ok', count: quotes.length, errors, ...orders };
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

// ───────── ref-sync(하루 1회): 한국 휴장일(KIS chk-holiday) + 배당 일정(M4: KIS ksdinfo/dividend, Alpaca corporate-actions) ─────────
// 배당은 보유·관심 종목만, 기준일(미국은 공급자 기준 날짜) 오늘 −40일 ~ +120일. 한 부분이 실패해도 나머지는 한다.
export const DIV_LOOKBACK_DAYS = 40;
export const DIV_LOOKAHEAD_DAYS = 120;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export async function runRefSync(d: {
  db: JobDb;
  kis: Kis | null;
  alpaca?: Alpaca | null;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<JobResult> {
  const errors: string[] = [];
  let ok = 0;
  let count = 0;
  const today = localDate(KR_TZ, d.now());
  const from = addDays(today, -DIV_LOOKBACK_DAYS);
  const to = addDays(today, DIV_LOOKAHEAD_DAYS);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const s = await d.db.settings();

  if (!d.kis) {
    errors.push('kis_not_configured');
  } else {
    try {
      const rows = await d.kis.holidays(today.replace(/-/g, ''));
      await d.db.saveCalendar(rows.map((r) => ({ market: 'KR', ...r, source_url: 'kis:chk-holiday' })));
      count += rows.length;
      ok++;
    } catch (e) {
      errors.push(`holidays:${errCode(e)}`);
    }
    try {
      const symbols = await d.db.dividendSymbols('KR', int(s.div_max_symbols_kr, 60));
      const rows: DividendRow[] = [];
      for (const sym of symbols) {
        try {
          rows.push(...(await d.kis.dividends(sym, from.replace(/-/g, ''), to.replace(/-/g, ''))).filter((r) => r.symbol === sym));
        } catch (e) {
          errors.push(`div:${sym}:${errCode(e)}`);
        }
        await sleep(int(s.kis_call_gap_ms, 70));
      }
      if (rows.length) count += await d.db.upsertDividendEvents(rows);
      ok++;
    } catch (e) {
      errors.push(`div_kr:${errCode(e)}`);
    }
  }
  if (d.alpaca === undefined || d.alpaca === null) {
    errors.push('alpaca_not_configured');
  } else {
    try {
      const symbols = await d.db.dividendSymbols('US', int(s.div_max_symbols_us, 100));
      if (symbols.length) {
        const rows = (await d.alpaca.dividends(symbols, from, to)).filter((r) => symbols.includes(r.symbol));
        if (rows.length) count += await d.db.upsertDividendEvents(rows);
      }
      ok++;
    } catch (e) {
      errors.push(`div_us:${errCode(e)}`);
    }
  }
  return ok === 0 ? { status: 'error', reason: errors[0] ?? 'nothing_done', errors } : { status: 'ok', count, errors };
}

// ───────── daily-close / tax-annual: DB 함수 하나씩(계산은 전부 DB) ─────────
export async function runDailyClose(d: { db: JobDb }): Promise<JobResult> {
  return { status: 'ok', ...(await d.db.dailyClose()) };
}

export async function runTaxAnnual(d: { db: JobDb }): Promise<JobResult> {
  return { status: 'ok', ...(await d.db.taxAnnual()) };
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
