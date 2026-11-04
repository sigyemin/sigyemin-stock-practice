// M4: 배당 일정 해석(KIS ksdinfo/dividend, Alpaca corporate-actions), ref-sync 배당 수집, 환전·납부 입력 검사. 계산은 DB — tests/sql/m4.test.sql
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKrDividends, ymd, createKis, KIS_ALLOW, KIS_ORIGIN, KIS_PATHS, KIS_TR } from '../../supabase/functions/_shared/providers/kis.ts';
import { parseUsDividends, createAlpaca, ALPACA_ALLOW } from '../../supabase/functions/_shared/providers/alpaca.ts';
import { isAllowed } from '../../supabase/functions/_shared/http.ts';
import { runRefSync, runDailyClose, runTaxAnnual } from '../../supabase/functions/_shared/jobs.ts';
import { parseFx, createFxHandler, createTaxPayHandler } from '../../supabase/functions/fx-convert/handler.ts';

const fx = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

test('날짜 해석: 여러 표기 허용, 없는 날짜·다른 모양은 null', () => {
  assert.equal(ymd('20261113'), '2026-11-13');
  assert.equal(ymd('2026/11/13'), '2026-11-13');
  assert.equal(ymd('2026-11-13'), '2026-11-13');
  assert.equal(ymd(' 2026.11.13 '), '2026-11-13');
  for (const bad of ['', null, undefined, '20261332', '2026-02-30', '261113', '2026-11-13T00:00:00Z']) assert.equal(ymd(bad), null, String(bad));
});

test('KIS 배당 일정: 현금배당·지급일 있는 행만, 락일 비움, 쉼표 금액', () => {
  const rows = parseKrDividends(fx('kis-ksdinfo-dividend.json').output1);
  assert.deepEqual(rows, [
    { market: 'KR', symbol: '999993', ex_date: null, record_date: '2026-11-13', pay_date: '2026-11-20', cash_per_share: 361, source: 'kis:ksdinfo-dividend' },
    { market: 'KR', symbol: '999993', ex_date: null, record_date: '2026-12-31', pay_date: '2027-04-15', cash_per_share: 1200, source: 'kis:ksdinfo-dividend' },
  ]);
  assert.deepEqual(parseKrDividends(undefined), []);
});

test('Alpaca 배당 일정: 달러·지급일 있는 행만', () => {
  const rows = parseUsDividends(fx('alpaca-corporate-actions.json'));
  assert.deepEqual(rows, [
    { market: 'US', symbol: 'TSTA', ex_date: '2026-11-12', record_date: '2026-11-13', pay_date: '2026-11-20', cash_per_share: 0.26, source: 'alpaca:corporate-actions' },
  ]);
  assert.deepEqual(parseUsDividends({}), []);
});

test('allowlist: KIS 배당 일정 경로는 GET + HHKDB669102C0 만, ksdinfo 다른 경로 차단', () => {
  const u = `${KIS_ORIGIN}${KIS_PATHS.dividend}?SHT_CD=999993`;
  assert.equal(isAllowed(KIS_ALLOW, u, { method: 'GET', headers: { tr_id: KIS_TR.dividend } }), true);
  assert.equal(isAllowed(KIS_ALLOW, u, { method: 'GET', headers: { tr_id: KIS_TR.price } }), false);
  assert.equal(isAllowed(KIS_ALLOW, u, { method: 'POST', headers: { tr_id: KIS_TR.dividend } }), false);
  assert.equal(isAllowed(KIS_ALLOW, `${KIS_ORIGIN}/uapi/domestic-stock/v1/ksdinfo/bonus-issue`, { method: 'GET', headers: { tr_id: KIS_TR.dividend } }), false);
});

test('allowlist: Alpaca corporate-actions 는 GET 만, v1 다른 경로 차단', () => {
  assert.equal(isAllowed(ALPACA_ALLOW, 'https://data.alpaca.markets/v1/corporate-actions?symbols=TSTA', { method: 'GET' }), true);
  assert.equal(isAllowed(ALPACA_ALLOW, 'https://data.alpaca.markets/v1/corporate-actions', { method: 'POST' }), false);
  assert.equal(isAllowed(ALPACA_ALLOW, 'https://data.alpaca.markets/v1beta1/news', { method: 'GET' }), false);
  assert.equal(isAllowed(ALPACA_ALLOW, 'https://paper-api.alpaca.markets/v1/corporate-actions', { method: 'GET' }), false);
});

test('Alpaca 배당: 페이지 따라가기, 요청 모양', async () => {
  const urls = [];
  const pages = [
    { corporate_actions: { cash_dividends: [{ symbol: 'TSTA', rate: 0.26, ex_date: '2026-11-12', record_date: '2026-11-13', payable_date: '2026-11-20', currency: 'USD' }] }, next_page_token: 'p2' },
    { corporate_actions: { cash_dividends: [{ symbol: 'TSTB', rate: 1.5, ex_date: '2026-12-01', record_date: '2026-12-02', payable_date: '2026-12-15' }] }, next_page_token: null },
  ];
  const transport = async (u) => { urls.push(String(u)); return new Response(JSON.stringify(pages[urls.length - 1])); };
  const a = createAlpaca({ keyId: 'k', secretKey: 's', transport });
  const rows = await a.dividends(['TSTA', 'TSTB'], '2026-10-01', '2027-03-01');
  assert.deepEqual(rows.map((r) => r.symbol), ['TSTA', 'TSTB']);
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get('types'), 'cash_dividend');
  assert.equal(q.get('symbols'), 'TSTA,TSTB');
  assert.equal(q.get('start'), '2026-10-01');
  assert.equal(q.get('end'), '2027-03-01');
  assert.equal(new URL(urls[1]).searchParams.get('page_token'), 'p2');
});

test('KIS 배당: 요청 변수·tr_id', async () => {
  const seen = [];
  const kv = { get: async (k) => (k === 'kis_token' ? { value: 'T', expires_at: '2099-01-01T00:00:00Z' } : null), set: async () => {}, claim: async () => true };
  const transport = async (u, init) => { seen.push({ u: String(u), tr: init.headers.tr_id }); return new Response(JSON.stringify({ rt_cd: '0', output1: fx('kis-ksdinfo-dividend.json').output1 })); };
  const k = createKis({ appKey: 'a', appSecret: 'b', kv, transport });
  const rows = await k.dividends('999993', '20261001', '20270301');
  assert.equal(rows.length, 2);
  const q = new URL(seen[0].u).searchParams;
  assert.equal(seen[0].tr, 'HHKDB669102C0');
  assert.deepEqual(Object.fromEntries(q), { CTS: '', GB1: '0', F_DT: '20261001', T_DT: '20270301', SHT_CD: '999993', HIGH_GB: '' });
});

function refDb() {
  const saved = { calendar: [], div: [] };
  const db = {
    settings: async () => ({ kis_call_gap_ms: '1' }),
    saveCalendar: async (r) => saved.calendar.push(...r),
    dividendSymbols: async (m) => (m === 'KR' ? ['999993', '999990'] : ['TSTA']),
    upsertDividendEvents: async (rows) => { saved.div.push(...rows); return rows.length; },
  };
  return { db, saved };
}
const NOW = () => new Date('2026-11-04T22:40:00Z'); // 한국 11-05 07:40

test('ref-sync: 휴장일 + 한국·미국 배당 일정, 기간 −40 ~ +120일, 다른 종목 행은 버림', async () => {
  const { db, saved } = refDb();
  const asked = [];
  const kis = {
    holidays: async () => [{ trade_date: '2026-11-07', is_open: false }],
    dividends: async (sym, from, to) => {
      asked.push([sym, from, to]);
      if (sym === '999990') throw Object.assign(new Error('x'), { name: 'KisError', code: 'EGW00201' });
      return parseKrDividends(fx('kis-ksdinfo-dividend.json').output1).concat([{ ...parseKrDividends(fx('kis-ksdinfo-dividend.json').output1)[0], symbol: '111111' }]);
    },
  };
  let usArgs;
  const alpaca = { dividends: async (syms, from, to) => { usArgs = [syms, from, to]; return parseUsDividends(fx('alpaca-corporate-actions.json')).concat([{ symbol: 'OTHER' }]); } };
  const r = await runRefSync({ db, kis, alpaca, now: NOW, sleep: async () => {} });
  assert.equal(r.status, 'ok');
  assert.deepEqual(asked[0], ['999993', '20260926', '20270305']);
  assert.deepEqual(usArgs, [['TSTA'], '2026-09-26', '2027-03-05']);
  assert.deepEqual(saved.div.map((x) => x.symbol), ['999993', '999993', 'TSTA']);
  assert.deepEqual(r.errors, ['div:999990:KisError:EGW00201']);
  assert.equal(saved.calendar.length, 1);
  assert.equal(r.count, 1 + 3);
});

test('ref-sync: 키 없으면 그 부분만 건너뜀, 둘 다 없으면 오류', async () => {
  const { db, saved } = refDb();
  const alpaca = { dividends: async () => parseUsDividends(fx('alpaca-corporate-actions.json')) };
  const r = await runRefSync({ db, kis: null, alpaca, now: NOW });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.errors, ['kis_not_configured']);
  assert.equal(saved.div.length, 1);
  const e = await runRefSync({ db, kis: null, alpaca: null, now: NOW });
  assert.equal(e.status, 'error');
  assert.equal(e.reason, 'kis_not_configured');
});

test('daily-close·tax-annual: DB 함수 결과를 그대로', async () => {
  const db = { dailyClose: async () => ({ fx_filled: 1, entitled: 2, paid: 3 }), taxAnnual: async () => ({ assessed: 1, auto_paid: 0 }) };
  assert.deepEqual(await runDailyClose({ db }), { status: 'ok', fx_filled: 1, entitled: 2, paid: 3 });
  assert.deepEqual(await runTaxAnnual({ db }), { status: 'ok', assessed: 1, auto_paid: 0 });
});

test('환전 입력 검사', () => {
  assert.deepEqual(parseFx({ direction: 'KRW_TO_USD', amount: 1000000 }), { direction: 'KRW_TO_USD', amount: '1000000', dry_run: false });
  assert.deepEqual(parseFx({ direction: 'USD_TO_KRW', amount: '100.25', dry_run: true }), { direction: 'USD_TO_KRW', amount: '100.25', dry_run: true });
  const bad = [
    [{ direction: 'X', amount: 1 }, 'invalid_direction'], [{ amount: 1 }, 'invalid_direction'],
    [{ direction: 'KRW_TO_USD', amount: 1.5 }, 'invalid_amount'], [{ direction: 'KRW_TO_USD', amount: 0 }, 'invalid_amount'],
    [{ direction: 'KRW_TO_USD', amount: -1 }, 'invalid_amount'], [{ direction: 'KRW_TO_USD', amount: '1e6' }, 'invalid_amount'],
    [{ direction: 'KRW_TO_USD', amount: 'NaN' }, 'invalid_amount'], [{ direction: 'USD_TO_KRW', amount: '1.005' }, 'invalid_amount'],
    [{ direction: 'KRW_TO_USD', amount: '1000000000000' }, 'invalid_amount'], [{ direction: 'KRW_TO_USD' }, 'invalid_amount'],
  ];
  for (const [b, e] of bad) assert.equal(parseFx(b), e, JSON.stringify(b));
});

const post = (h, token, body) => h(new Request('https://fn.test/x', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }))
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const getCaller = async (jwt) => (jwt === 'tok' ? { participantId: 1, canFundBot: true } : jwt === 'unreg' ? null : 'invalid');

test('fx-convert: 인증·전달·DB 오류 코드', async () => {
  const calls = [];
  let reply = { data: { ok: true, usd_amount: 713.57 } };
  const h = createFxHandler({ allowedOrigins: [], getCaller, fxConvert: async (jwt, i) => { calls.push([jwt, i]); return reply; } });
  const body = { direction: 'KRW_TO_USD', amount: 1000000, dry_run: true };
  assert.equal((await post(h, null, body)).status, 401);
  assert.equal((await post(h, 'bad', body)).status, 401);
  assert.equal((await post(h, 'unreg', body)).status, 403);
  assert.deepEqual(await post(h, 'tok', body), { status: 200, body: { ok: true, usd_amount: 713.57 } });
  assert.deepEqual(calls[0], ['tok', { direction: 'KRW_TO_USD', amount: '1000000', dry_run: true }]);
  assert.deepEqual(await post(h, 'tok', { ...body, amount: 1.5 }), { status: 400, body: { ok: false, error: 'invalid_amount' } });
  assert.equal(calls.length, 1, '입력이 틀리면 DB 를 부르지 않음');
  reply = { errorCode: '22023', message: 'fx_stale' };
  assert.deepEqual(await post(h, 'tok', body), { status: 400, body: { ok: false, error: 'fx_stale' } });
  reply = { errorCode: '22023', message: 'something internal' };
  assert.deepEqual(await post(h, 'tok', body), { status: 400, body: { ok: false, error: 'server_error' } });
});

test('tax-pay: 연도 검사·전달·오류 코드', async () => {
  const calls = [];
  let reply = { data: { ok: true, tax_year: 2026, tax_krw: 220000 } };
  const h = createTaxPayHandler({ allowedOrigins: [], getCaller, cgtPay: async (jwt, y) => { calls.push(y); return reply; } });
  assert.equal((await post(h, 'tok', { year: '2026' })).body.error, 'invalid_year');
  assert.equal((await post(h, 'tok', { year: 1999 })).body.error, 'invalid_year');
  assert.deepEqual(await post(h, 'tok', { year: 2026 }), { status: 200, body: { ok: true, tax_year: 2026, tax_krw: 220000 } });
  assert.deepEqual(calls, [2026]);
  reply = { errorCode: '22023', message: 'not_payment_period' };
  assert.deepEqual(await post(h, 'tok', { year: 2026 }), { status: 400, body: { ok: false, error: 'not_payment_period' } });
  reply = { errorCode: '42501', message: 'not_registered' };
  assert.equal((await post(h, 'tok', { year: 2026 })).status, 403);
});
