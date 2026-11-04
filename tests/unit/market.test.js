// 장 시간·호가·상하한가·예약 작업 시험(합성 데이터)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKrxOpen, isNyseOpen, localDate, localHhmmss, US_TZ } from '../../supabase/functions/_shared/market-time.ts';
import { tickFor, krLimits, isOnTick } from '../../supabase/functions/_shared/price-rules.ts';
import { runTickKr, runTickUs, runFxSync, runRefSync, backfillDaily, saneBar } from '../../supabase/functions/_shared/jobs.ts';
import { createHandler, ProviderNotConfigured } from '../../supabase/functions/instrument-lookup/handler.ts';

// 0004 시드와 같은 구간(요율표 §1.1). 시험에서는 코드에 박지 않은 값을 "DB 에서 읽은 것"으로 넘긴다.
const KR_TICK = [
  { lt: 2000, tick: 1 }, { lt: 5000, tick: 5 }, { lt: 20000, tick: 10 }, { lt: 50000, tick: 50 },
  { lt: 200000, tick: 100 }, { lt: 500000, tick: 500 }, { lt: null, tick: 1000 },
];

test('호가단위 경계값', () => {
  const cases = [[1999, 1], [2000, 5], [4999, 5], [5000, 10], [19990, 10], [20000, 50], [49950, 50], [50000, 100],
    [199900, 100], [200000, 500], [499500, 500], [500000, 1000]];
  for (const [p, t] of cases) assert.equal(tickFor(p, KR_TICK), t, String(p));
  assert.equal(isOnTick(70100, KR_TICK), true);
  assert.equal(isOnTick(70150, KR_TICK), false);
  assert.throws(() => tickFor(0.5, [{ lt: 1, tick: null }]), RangeError);
});

test('상·하한가: KRX 예시 기준 9,980 → 12,970 / 6,990', () => {
  assert.deepEqual(krLimits(9980, 0.3, KR_TICK), { upper: 12970, lower: 6990 });
  assert.deepEqual(krLimits(69900, 0.3, KR_TICK), { upper: 90800, lower: 49000 });
});

test('KRX 장 시간(한국 시간 09:00~15:30), 주말·휴장일', () => {
  assert.equal(isKrxOpen(new Date('2026-11-04T00:00:00Z')), true, '수 09:00');
  assert.equal(isKrxOpen(new Date('2026-11-03T23:59:00Z')), false, '수 08:59');
  assert.equal(isKrxOpen(new Date('2026-11-04T06:29:00Z')), true, '15:29');
  assert.equal(isKrxOpen(new Date('2026-11-04T06:30:00Z')), false, '15:30 마감');
  assert.equal(isKrxOpen(new Date('2026-11-04T06:34:00Z'), null, 5), true, '마감 뒤 5분 유예');
  assert.equal(isKrxOpen(new Date('2026-11-07T01:00:00Z')), false, '토요일');
  const holiday = { trade_date: '2026-11-04', is_open: false, open_at: null, close_at: null };
  assert.equal(isKrxOpen(new Date('2026-11-04T01:00:00Z'), holiday), false, '휴장일 행');
  const other = { trade_date: '2026-11-05', is_open: false, open_at: null, close_at: null };
  assert.equal(isKrxOpen(new Date('2026-11-04T01:00:00Z'), other), true, '다른 날 행은 무시');
});

test('NYSE 장 시간: 서머타임 전후, 조기폐장 13:00', () => {
  // 2026-10-30(금, EDT UTC-4): 09:30 ET = 13:30Z
  assert.equal(isNyseOpen(new Date('2026-10-30T13:30:00Z')), true);
  assert.equal(isNyseOpen(new Date('2026-10-30T13:29:00Z')), false);
  assert.equal(isNyseOpen(new Date('2026-10-30T19:59:00Z')), true, '15:59 EDT');
  assert.equal(isNyseOpen(new Date('2026-10-30T20:00:00Z')), false, '16:00 EDT');
  // 2026-11-02(월, EST UTC-5, 11-01 서머타임 끝): 09:30 ET = 14:30Z
  assert.equal(isNyseOpen(new Date('2026-11-02T13:30:00Z')), false, 'EST 에서는 08:30');
  assert.equal(isNyseOpen(new Date('2026-11-02T14:30:00Z')), true);
  assert.equal(isNyseOpen(new Date('2026-11-02T20:59:00Z')), true, '15:59 EST');
  assert.equal(isNyseOpen(new Date('2026-11-02T21:00:00Z')), false);
  // 조기폐장 2026-11-27 13:00 ET = 18:00Z (0004 시드와 같은 값)
  const early = { trade_date: '2026-11-27', is_open: true, open_at: null, close_at: '2026-11-27T18:00:00Z' };
  assert.equal(isNyseOpen(new Date('2026-11-27T17:59:00Z'), early), true);
  assert.equal(isNyseOpen(new Date('2026-11-27T18:00:00Z'), early), false);
  assert.equal(isNyseOpen(new Date('2026-11-27T18:04:00Z'), early, 5), true, '유예');
  const thanks = { trade_date: '2026-11-26', is_open: false, open_at: null, close_at: null };
  assert.equal(isNyseOpen(new Date('2026-11-26T16:00:00Z'), thanks), false);
  assert.equal(localDate(US_TZ, new Date('2026-11-03T03:00:00Z')), '2026-11-02', '뉴욕 날짜');
  assert.equal(localHhmmss('Asia/Seoul', new Date('2026-11-04T01:02:03Z')), '100203');
});

// ───────── 예약 작업 ─────────
function memDb(over = {}) {
  const saved = { quotes: [], candles: [], fx: [], calendar: [] };
  const db = {
    settings: async () => ({ kr_quote_mode: 'realtime', tick_max_symbols_kr: '2', tick_max_symbols_us: '30', tick_time_budget_ms: '100000', kis_call_gap_ms: '1', ...over }),
    calendar: async () => null,
    watchSymbols: async (m, limit) => (m === 'KR' ? ['999990', '999991', '999992'] : ['TSTA']).slice(0, limit),
    saveQuotes: async (r) => saved.quotes.push(...r),
    saveCandles: async (r) => saved.candles.push(...r),
    saveFx: async (d, v, s) => saved.fx.push({ d, v, s }),
    saveCalendar: async (r) => saved.calendar.push(...r),
  };
  return { db, saved };
}

const fakeKis = (failOn = null) => ({
  async price(sym) {
    if (sym === failOn) throw Object.assign(new Error('x'), { name: 'KisError', code: 'EGW00201' });
    return { price: 70100, open: 69800, high: 70500, low: 69500, volume: 10, base_price: 69900, upper_limit: 90800, lower_limit: 49000 };
  },
  async minuteBars() { return [{ t: '2026-11-04T01:00:00.000Z', o: 1, h: 2, l: 1, c: 2, v: 1 }, { t: '2026-11-04T01:01:00.000Z', o: 5, h: 4, l: 6, c: 5, v: 1 }]; },
  async holidays() { return [{ trade_date: '2026-11-07', is_open: false }]; },
  async dailyBars(_s, from, to) {
    // to 부터 거꾸로 3일씩만 주는 가짜(페이지 넘김 시험)
    if (to < from) return [];
    const kst = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00+09:00`);
    const end = kst(to);
    return [2, 1, 0].map((k) => end - k * 86400000).filter((t) => t >= kst(from))
      .map((t) => ({ t: new Date(t).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 }));
  },
});

const OPEN_KR = () => new Date('2026-11-04T01:02:00Z'); // 수 10:02 KST

test('tick-kr: 지연 모드면 외부 호출 없이 건너뜀', async () => {
  const { db } = memDb({ kr_quote_mode: 'delayed' });
  let called = false;
  const kis = new Proxy({}, { get: () => { called = true; return async () => ({}); } });
  assert.deepEqual(await runTickKr({ db, kis, now: OPEN_KR, sleep: async () => {} }), { status: 'skipped', reason: 'mode_delayed' });
  assert.equal(called, false);
});

test('tick-kr: 장 밖이면 건너뜀, 키 없으면 오류', async () => {
  const { db } = memDb();
  assert.equal((await runTickKr({ db, kis: fakeKis(), now: () => new Date('2026-11-04T07:00:00Z'), sleep: async () => {} })).reason, 'market_closed');
  assert.equal((await runTickKr({ db, kis: null, now: OPEN_KR, sleep: async () => {} })).reason, 'kis_not_configured');
});

test('tick-kr: 상한 수만큼 처리, 종목별 오류는 기록하고 계속, 이상한 봉은 버림', async () => {
  const { db, saved } = memDb();
  const r = await runTickKr({ db, kis: fakeKis('999990'), now: OPEN_KR, sleep: async () => {} });
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 1, '상한 2 중 1개 실패');
  assert.deepEqual(r.errors, ['999990:KisError:EGW00201']);
  assert.equal(saved.quotes[0].symbol, '999991');
  assert.equal(saved.quotes[0].mode, 'realtime');
  assert.equal(saved.quotes[0].upper_limit, 90800);
  const m1 = saved.candles.filter((c) => c.tf === '1m');
  assert.equal(m1.length, 1, '고가<저가 봉 1개 버림');
  const d1 = saved.candles.find((c) => c.tf === '1d');
  assert.equal(d1.t, '2026-11-03T15:00:00.000Z', '오늘 일봉 = 한국 00:00');
  assert.equal(d1.c, 70100);
});

test('tick-kr: 시간 예산을 넘으면 멈춤', async () => {
  const { db, saved } = memDb({ tick_max_symbols_kr: '3', tick_time_budget_ms: '1000' });
  let t = OPEN_KR().getTime();
  const r = await runTickKr({ db, kis: fakeKis(), now: () => new Date(t), sleep: async () => { t += 600; } });
  assert.ok(r.errors.includes('time_budget'));
  assert.equal(saved.quotes.length, 1);
});

test('tick-us: 장중 스냅샷·1분봉 저장, 휴장일·키 없음 처리', async () => {
  const alpaca = {
    async snapshots() { return { TSTA: { price: 200.5, quote_at: '2026-11-03T20:59:59.000Z', open: 198, high: 201, low: 197.5, volume: 1, prev_close: 199, daily_t: '2026-11-03T05:00:00.000Z' }, OTHER: { price: 1 } }; },
    async bars() { return { TSTA: [{ t: '2026-11-03T20:58:00.000Z', o: 200, h: 200.4, l: 200, c: 200.3, v: 1 }] }; },
  };
  const { db, saved } = memDb();
  const r = await runTickUs({ db, alpaca, now: () => new Date('2026-11-03T20:59:00Z') });
  assert.equal(r.count, 1, '요청하지 않은 종목은 무시');
  assert.equal(saved.quotes[0].source, 'alpaca_iex');
  assert.equal(saved.candles.filter((c) => c.tf === '1m').length, 1);
  assert.equal(saved.candles.find((c) => c.tf === '1d').t, '2026-11-03T05:00:00.000Z');
  const hol = memDb();
  hol.db.calendar = async () => ({ trade_date: '2026-11-26', is_open: false, open_at: null, close_at: null });
  assert.equal((await runTickUs({ db: hol.db, alpaca, now: () => new Date('2026-11-26T16:00:00Z') })).reason, 'market_closed');
  assert.equal((await runTickUs({ db, alpaca: null, now: () => new Date('2026-11-03T20:59:00Z') })).reason, 'alpaca_not_configured');
});

test('fx-sync: 고시값 저장, 아직 없으면 저장하지 않음', async () => {
  const { db, saved } = memDb();
  const now = () => new Date('2026-11-04T03:00:00Z');
  assert.equal((await runFxSync({ db, exim: { usdkrw: async (d) => (d === '20261104' ? 1401.5 : null) }, now })).status, 'ok');
  assert.deepEqual(saved.fx, [{ d: '2026-11-04', v: 1401.5, s: 'koreaexim' }]);
  assert.equal((await runFxSync({ db, exim: { usdkrw: async () => null }, now })).reason, 'no_rate_yet');
  assert.equal(saved.fx.length, 1);
  assert.equal((await runFxSync({ db, exim: null, now })).reason, 'koreaexim_not_configured');
});

test('ref-sync: 한국 휴장일을 KR 행으로 저장', async () => {
  const { db, saved } = memDb();
  await runRefSync({ db, kis: fakeKis(), now: OPEN_KR });
  assert.deepEqual(saved.calendar, [{ market: 'KR', trade_date: '2026-11-07', is_open: false, source_url: 'kis:chk-holiday' }]);
});

test('일봉 받아 오기: KIS 페이지를 거슬러 올라가며 중복 없이', async () => {
  const rows = await backfillDaily({ market: 'KR', symbol: '999990', days: 5, kis: fakeKis(), alpaca: null, now: OPEN_KR });
  const ts = rows.map((r) => r.t);
  assert.equal(new Set(ts).size, ts.length);
  assert.deepEqual([...ts].sort(), ts, '오름차순');
  assert.ok(rows.length >= 5 && rows.every((r) => r.tf === '1d' && r.source === 'kis'));
  assert.deepEqual(await backfillDaily({ market: 'US', symbol: 'TSTA', days: 5, kis: null, alpaca: null, now: OPEN_KR }), []);
  assert.equal(saneBar({ o: 1, h: 1, l: 0, c: 1 }), false, '0원 봉 거부');
});

// ───────── instrument-lookup ─────────
function lookupHandler(over = {}) {
  const saved = { inst: [], candles: [] };
  const h = createHandler({
    allowedOrigins: [],
    getCaller: async (jwt) => (jwt === 'tok-min' ? { participantId: 1, canFundBot: true } : jwt === 'tok-unreg' ? null : 'invalid'),
    findInstrument: async (m, s) => (s === '999990' ? { market: 'KR', symbol: s, name: '시험종목가', exchange: 'KOSPI', currency: 'KRW' } : null),
    lookup: async (m, s) => (s === '999991' || s === 'TSTA' ? { market: m, symbol: s, name: 'x', exchange: m === 'KR' ? 'KOSDAQ' : 'NASDAQ', currency: m === 'KR' ? 'KRW' : 'USD' } : null),
    saveInstrument: async (i) => saved.inst.push(i),
    backfill: async () => [{ t: '2026-11-03T15:00:00.000Z', o: 1, h: 1, l: 1, c: 1, v: 1, market: 'KR', symbol: '999991', tf: '1d', source: 'kis' }],
    saveCandles: async (r) => saved.candles.push(...r),
    ...over,
  });
  const call = async (token, body) => {
    const r = await h(new Request('https://fn.test/instrument-lookup', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { call, saved };
}

test('instrument-lookup: 있는 종목은 그대로, 없는 종목은 저장 + 일봉', async () => {
  const { call, saved } = lookupHandler();
  const a = await call('tok-min', { market: 'KR', symbol: '999990' });
  assert.deepEqual([a.status, a.body.created], [200, false]);
  const b = await call('tok-min', { market: 'KR', symbol: '999991' });
  assert.deepEqual([b.status, b.body.created, b.body.candles], [200, true, 1]);
  const c = await call('tok-min', { market: 'US', symbol: 'tsta' });
  assert.equal(c.body.instrument.symbol, 'TSTA', '티커는 대문자로');
  assert.equal(saved.inst.length, 2);
});

test('instrument-lookup: 인증·입력 검사, 공급자 키 없음·없는 종목', async () => {
  const { call } = lookupHandler();
  assert.equal((await call(null, { market: 'KR', symbol: '999990' })).status, 401);
  assert.equal((await call('tok-x', { market: 'KR', symbol: '999990' })).status, 401);
  assert.equal((await call('tok-unreg', { market: 'KR', symbol: '999990' })).status, 403);
  for (const b of [{ market: 'JP', symbol: '1234' }, { market: 'KR', symbol: '12345' }, { market: 'KR', symbol: '00593A' },
    { market: 'US', symbol: '1ABC' }, { market: 'US', symbol: 'TOOLONGTICKER' }, { market: 'US', symbol: '../X' }, { market: 'KR' }]) {
    assert.equal((await call('tok-min', b)).status, 400, JSON.stringify(b));
  }
  assert.equal((await call('tok-min', { market: 'KR', symbol: '999999' })).status, 404);
  const np = lookupHandler({ lookup: async () => { throw new ProviderNotConfigured(); } });
  assert.equal((await np.call('tok-min', { market: 'KR', symbol: '999998' })).status, 503);
  const bf = lookupHandler({ backfill: async () => { throw new Error('x'); } });
  const r = await bf.call('tok-min', { market: 'KR', symbol: '999991' });
  assert.deepEqual([r.status, r.body.candles], [200, 0], '일봉 실패해도 종목 추가는 성공');
});
