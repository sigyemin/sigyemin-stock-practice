// 시세 공급자 어댑터 시험: 허용 목록, KIS 토큰 재사용, 응답 해석(합성 응답 고정 파일)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardedFetch, isAllowed, AllowlistError } from '../../supabase/functions/_shared/http.ts';
import { MemoryKv, verifyCronToken, safeEqual } from '../../supabase/functions/_shared/kv.ts';
import {
  createKis, KIS_ALLOW, KIS_ORIGIN, KIS_TR, KIS_PATHS, KisError, parseStockInfo, parseHolidays, tokenExpiry, kstToIso,
} from '../../supabase/functions/_shared/providers/kis.ts';
import { createAlpaca, ALPACA_ALLOW, parseAsset } from '../../supabase/functions/_shared/providers/alpaca.ts';
import { createExim, parseUsdKrw, EXIM_ALLOW } from '../../supabase/functions/_shared/providers/koreaexim.ts';
import { KRX_ALLOW, DATAGOKR_ALLOW, createDelayedKr } from '../../supabase/functions/_shared/providers/delayed.ts';
import { parseKrMode, krPlan } from '../../supabase/functions/_shared/providers/index.ts';

const fx = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 가짜 KIS 서버: 경로·tr_id 로 고정 응답
function fakeKis({ tokenStatus = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const tr = new Headers(init.headers).get('tr_id');
    calls.push({ path: u.pathname, tr, method: init.method, auth: new Headers(init.headers).get('authorization'), q: Object.fromEntries(u.searchParams) });
    if (u.pathname === KIS_PATHS.token) {
      return tokenStatus === 200
        ? res({ access_token: `tok${calls.filter((c) => c.path === KIS_PATHS.token).length}`, token_type: 'Bearer', expires_in: 86400 })
        : res({ error_code: 'EGW00133' }, tokenStatus);
    }
    const map = {
      [KIS_TR.price]: 'kis-inquire-price.json',
      [KIS_TR.minute]: 'kis-time-itemchartprice.json',
      [KIS_TR.daily]: 'kis-daily-itemchartprice.json',
      [KIS_TR.holiday]: 'kis-chk-holiday.json',
      [KIS_TR.stockInfo]: 'kis-search-stock-info.json',
    };
    return res(fx(map[tr]));
  };
  return { fetch, calls };
}

// ───────── 허용 목록 ─────────
test('allowlist: KIS 시세 경로·TR 만 통과, 주문·잔고 경로는 차단', async () => {
  assert.equal(isAllowed(KIS_ALLOW, `${KIS_ORIGIN}${KIS_PATHS.price}?x=1`, { method: 'GET', headers: { tr_id: KIS_TR.price } }), true);
  const blocked = [
    // 주문(현금) 경로 — 코드에는 없고, 누가 넣어도 막혀야 함
    [`${KIS_ORIGIN}/uapi/domestic-stock/v1/trading/order-cash`, 'POST', 'TTTC0012U'],
    [`${KIS_ORIGIN}/uapi/domestic-stock/v1/trading/inquire-balance`, 'GET', 'TTTC8434R'],
    [`${KIS_ORIGIN}/uapi/overseas-stock/v1/trading/order`, 'POST', 'TTTT1002U'],
    // 허용 경로라도 다른 TR ID 면 차단
    [`${KIS_ORIGIN}${KIS_PATHS.price}`, 'GET', 'TTTC0012U'],
    // 허용 경로라도 메서드가 다르면 차단
    [`${KIS_ORIGIN}${KIS_PATHS.price}`, 'POST', KIS_TR.price],
    // 모의투자 도메인·http·다른 포트
    [`https://openapivts.koreainvestment.com:29443${KIS_PATHS.price}`, 'GET', KIS_TR.price],
    [`http://openapi.koreainvestment.com:9443${KIS_PATHS.price}`, 'GET', KIS_TR.price],
    [`https://openapi.koreainvestment.com${KIS_PATHS.price}`, 'GET', KIS_TR.price],
    // 경로 우회 시도
    [`${KIS_ORIGIN}${KIS_PATHS.price}/../../trading/order-cash`, 'GET', KIS_TR.price],
    [`${KIS_ORIGIN}${KIS_PATHS.price}x`, 'GET', KIS_TR.price],
    [`https://user:pw@openapi.koreainvestment.com:9443${KIS_PATHS.price}`, 'GET', KIS_TR.price],
  ];
  let sent = 0;
  const f = guardedFetch(KIS_ALLOW, async () => { sent++; return res({}); });
  for (const [url, method, tr] of blocked) {
    await assert.rejects(f(url, { method, headers: { tr_id: tr } }), AllowlistError, `${method} ${url} ${tr}`);
  }
  assert.equal(sent, 0, '차단된 요청은 네트워크로 나가지 않음');
});

test('allowlist: 토큰 경로는 tr_id 없이 POST 만', () => {
  assert.equal(isAllowed(KIS_ALLOW, `${KIS_ORIGIN}${KIS_PATHS.token}`, { method: 'POST' }), true);
  assert.equal(isAllowed(KIS_ALLOW, `${KIS_ORIGIN}${KIS_PATHS.token}`, { method: 'GET' }), false);
  assert.equal(isAllowed(KIS_ALLOW, `${KIS_ORIGIN}/oauth2/Approval`, { method: 'POST' }), false);
});

test('allowlist: KIS 코드에 주문·잔고·계좌 관련 경로·TR 문자열이 없음', () => {
  const src = readFileSync(new URL('../../supabase/functions/_shared/providers/kis.ts', import.meta.url), 'utf8');
  for (const bad of ['/trading/', 'order', 'balance', 'TTTC', 'VTTC', 'CANO', 'ACNT_PRDT_CD', 'hashkey']) {
    assert.equal(src.includes(bad), false, bad);
  }
  for (const r of KIS_ALLOW) assert.ok(String(r.path).includes('/quotations/') || r.path === '/oauth2/tokenP');
});

test('allowlist: Alpaca 는 시세 2개 + assets 조회만, 주문·계좌 경로 차단', () => {
  const ok = [
    ['https://data.alpaca.markets/v2/stocks/snapshots?symbols=TSTA', 'GET'],
    ['https://data.alpaca.markets/v2/stocks/bars?symbols=TSTA', 'GET'],
    ['https://paper-api.alpaca.markets/v2/assets/TSTA', 'GET'],
  ];
  for (const [u, m] of ok) assert.equal(isAllowed(ALPACA_ALLOW, u, { method: m }), true, u);
  const bad = [
    ['https://paper-api.alpaca.markets/v2/orders', 'POST'],
    ['https://paper-api.alpaca.markets/v2/orders', 'GET'],
    ['https://paper-api.alpaca.markets/v2/account', 'GET'],
    ['https://paper-api.alpaca.markets/v2/positions', 'GET'],
    ['https://api.alpaca.markets/v2/assets/TSTA', 'GET'],
    ['https://paper-api.alpaca.markets/v2/assets/TSTA', 'DELETE'],
    ['https://paper-api.alpaca.markets/v2/assets/tsta', 'GET'],
    ['https://paper-api.alpaca.markets/v2/assets/TSTA/../../orders', 'GET'],
  ];
  for (const [u, m] of bad) assert.equal(isAllowed(ALPACA_ALLOW, u, { method: m }), false, `${m} ${u}`);
});

test('allowlist: 수출입은행 1개 경로, 지연 모드 어댑터는 비어 있음', async () => {
  assert.equal(EXIM_ALLOW.length, 1);
  assert.equal(KRX_ALLOW.length + DATAGOKR_ALLOW.length, 0);
  await assert.rejects(createDelayedKr().dailyClose('999990', '2026-11-04'), /not_implemented/);
});

// ───────── KIS 토큰 재사용 ─────────
test('KIS 토큰: 한 번 발급 후 재사용, 만료 30분 전부터 새로 발급', async () => {
  const kv = new MemoryKv();
  let now = new Date('2026-11-04T01:00:00Z');
  kv.now = () => now;
  const k = fakeKis();
  const kis = createKis({ appKey: 'k', appSecret: 's', kv, transport: k.fetch, now: () => now });
  await kis.price('999990');
  await kis.price('999990');
  await kis.minuteBars('999990', '100000');
  assert.equal(k.calls.filter((c) => c.path === KIS_PATHS.token).length, 1, '토큰 1번만 발급');
  assert.ok(k.calls.filter((c) => c.tr).every((c) => c.auth === 'Bearer tok1'));
  // 23시간 40분 뒤(만료 20분 전) → 새 발급
  now = new Date(now.getTime() + (23 * 60 + 40) * 60000);
  await kis.price('999990');
  assert.equal(k.calls.filter((c) => c.path === KIS_PATHS.token).length, 2);
  assert.equal((await kv.get('kis_token')).value, 'tok2');
});

test('KIS 토큰: 다른 실행(새 인스턴스)도 DB 에 저장된 토큰을 씀', async () => {
  const kv = new MemoryKv();
  const now = () => new Date('2026-11-04T01:00:00Z');
  const k1 = fakeKis();
  await createKis({ appKey: 'k', appSecret: 's', kv, transport: k1.fetch, now }).price('999990');
  const k2 = fakeKis();
  await createKis({ appKey: 'k', appSecret: 's', kv, transport: k2.fetch, now }).price('999990');
  assert.equal(k2.calls.filter((c) => c.path === KIS_PATHS.token).length, 0);
});

test('KIS 토큰: 발급 실패 뒤 65초 안에는 다시 발급하지 않음(알림톡·한도 보호)', async () => {
  const kv = new MemoryKv();
  let now = new Date('2026-11-04T01:00:00Z');
  kv.now = () => now;
  const bad = fakeKis({ tokenStatus: 500 });
  const kis = createKis({ appKey: 'k', appSecret: 's', kv, transport: bad.fetch, now: () => now });
  await assert.rejects(kis.price('999990'), (e) => e instanceof KisError && e.code === 'EGW00133');
  await assert.rejects(kis.price('999990'), (e) => e instanceof KisError && e.code === 'token_issue_throttled');
  assert.equal(bad.calls.filter((c) => c.path === KIS_PATHS.token).length, 1);
  now = new Date(now.getTime() + 66000);
  await assert.rejects(kis.price('999990'), (e) => e.code === 'EGW00133');
  assert.equal(bad.calls.filter((c) => c.path === KIS_PATHS.token).length, 2);
});

test('KIS 토큰: 발급이 401·403 이면 30분 동안 발급 금지', async () => {
  const kv = new MemoryKv();
  let now = new Date('2026-11-04T01:00:00Z');
  kv.now = () => now;
  const bad = fakeKis({ tokenStatus: 403 });
  const kis = createKis({ appKey: 'k', appSecret: 's', kv, transport: bad.fetch, now: () => now });
  await assert.rejects(kis.price('999990'), (e) => e.code === 'auth_failed');
  now = new Date(now.getTime() + 2 * 60000); // 2분 뒤(65초 간격은 지남)
  await assert.rejects(kis.price('999990'), (e) => e.code === 'auth_blocked');
  now = new Date(now.getTime() + 27 * 60000); // 29분 뒤
  await assert.rejects(kis.price('999990'), (e) => e.code === 'auth_blocked');
  assert.equal(bad.calls.filter((c) => c.path === KIS_PATHS.token).length, 1, '차단 동안 발급 요청 0');
  now = new Date(now.getTime() + 2 * 60000); // 31분 뒤
  await assert.rejects(kis.price('999990'), (e) => e.code === 'auth_failed');
  assert.equal(bad.calls.filter((c) => c.path === KIS_PATHS.token).length, 2);
});

test('KIS: 새 토큰으로도 401 이면 발급을 막고, 다음 실행도 재발급하지 않음(리뷰 L1)', async () => {
  const kv = new MemoryKv();
  let now = new Date('2026-11-04T01:00:00Z');
  kv.now = () => now;
  await kv.set('kis_token', 'old', new Date('2026-11-05T00:00:00Z'));
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === KIS_PATHS.token) return res({ access_token: `new${calls.length}`, expires_in: 86400 });
    return res({ rt_cd: '1', msg_cd: 'x' }, 401); // 항상 401(만료가 원인이 아님)
  };
  const kis = createKis({ appKey: 'k', appSecret: 's', kv, transport: fetch, now: () => now });
  await assert.rejects(kis.price('999990'), (e) => e.code === 'auth_failed');
  assert.deepEqual(calls, [KIS_PATHS.price, KIS_PATHS.token, KIS_PATHS.price], '재발급 1번 + 재시도 1번');
  // 이후 매분 실행(cron)을 30분 동안 흉내: 발급 요청은 더 없어야 함
  for (let i = 1; i <= 29; i++) {
    now = new Date(Date.parse('2026-11-04T01:00:00Z') + i * 60000);
    await assert.rejects(kis.price('999990'), (e) => e.code === 'auth_blocked');
  }
  assert.equal(calls.filter((p) => p === KIS_PATHS.token).length, 1);
  assert.ok((await kv.get('kis_token_bad_until')).value.startsWith('2026-11-04T01:30'));
});

test('KIS 토큰: 동시에 두 실행이 발급하려 해도 한 번만(claim, 리뷰 L2)', async () => {
  const kv = new MemoryKv();
  const now = () => new Date('2026-11-04T01:00:00Z');
  kv.now = now;
  const k = fakeKis();
  const a = createKis({ appKey: 'k', appSecret: 's', kv, transport: k.fetch, now });
  const b = createKis({ appKey: 'k', appSecret: 's', kv, transport: k.fetch, now });
  const r = await Promise.allSettled([a.token(), b.token()]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(r.find((x) => x.status === 'rejected').reason.code, 'token_issue_throttled');
  assert.equal(k.calls.filter((c) => c.path === KIS_PATHS.token).length, 1);
});

test('KIS 토큰 만료 시각: expires_in 우선, 없으면 KST 문자열', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  assert.equal(tokenExpiry({ expires_in: 86400 }, now).toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(tokenExpiry({ access_token_token_expired: '2026-11-05 09:00:00' }, now).toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(tokenExpiry({}, now).toISOString(), '2026-11-04T06:00:00.000Z');
});

test('KIS 401 이면 토큰을 새로 받아 한 번만 다시 시도', async () => {
  const kv = new MemoryKv();
  const now = () => new Date('2026-11-04T01:00:00Z');
  await kv.set('kis_token', 'old', new Date('2026-11-05T00:00:00Z'));
  let first = true;
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === KIS_PATHS.token) return res({ access_token: 'new', expires_in: 86400 });
    if (first) { first = false; return res({ rt_cd: '1', msg_cd: 'x' }, 401); }
    return res(fx('kis-inquire-price.json'));
  };
  const p = await createKis({ appKey: 'k', appSecret: 's', kv, transport: fetch, now }).price('999990');
  assert.equal(p.price, 70100);
  assert.deepEqual(calls, [KIS_PATHS.price, KIS_PATHS.token, KIS_PATHS.price]);
});

// ───────── KIS 응답 해석 ─────────
test('KIS 현재가·분봉·일봉·휴장일·종목 해석', async () => {
  const kv = new MemoryKv();
  const k = fakeKis();
  const kis = createKis({ appKey: 'k', appSecret: 's', kv, transport: k.fetch, now: () => new Date('2026-11-04T01:00:00Z') });
  const p = await kis.price('999990');
  assert.deepEqual(p, { price: 70100, open: 69800, high: 70500, low: 69500, volume: 1234567, base_price: 69900, upper_limit: 90800, lower_limit: 49000 });
  const m = await kis.minuteBars('999990', '100200');
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { t: '2026-11-04T01:00:00.000Z', o: 70000, h: 70100, l: 69900, c: 70050, v: 1500 });
  assert.equal(m[2].t, '2026-11-04T01:02:00.000Z', '오름차순 정렬');
  const q = k.calls.find((c) => c.tr === KIS_TR.minute).q;
  assert.equal(q.FID_INPUT_HOUR_1, '100200');
  assert.equal(q.FID_COND_MRKT_DIV_CODE, 'J');
  const dly = await kis.dailyBars('999990', '20261001', '20261104');
  assert.deepEqual(dly.map((b) => b.t), ['2026-11-02T15:00:00.000Z', '2026-11-03T15:00:00.000Z']);
  assert.equal(dly[1].c, 70100);
  const h = await kis.holidays('20261104');
  assert.deepEqual(h, [
    { trade_date: '2026-11-04', is_open: true },
    { trade_date: '2026-11-07', is_open: false },
  ]);
  const info = await kis.stockInfo('999990');
  assert.deepEqual(info, { market: 'KR', symbol: '999990', name: '시험종목가', exchange: 'KOSPI', currency: 'KRW' });
});

test('KIS rt_cd 가 0 이 아니면 오류(msg_cd 전달)', async () => {
  const kv = new MemoryKv();
  const fetch = async (url) => new URL(url).pathname === KIS_PATHS.token ? res({ access_token: 't', expires_in: 86400 }) : res({ rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수 초과' });
  await assert.rejects(createKis({ appKey: 'k', appSecret: 's', kv, transport: fetch }).price('999990'), (e) => e.code === 'EGW00201');
});

test('KIS 종목 해석: 주권만, 코스닥 판정, 상장폐지·ETF 제외', () => {
  assert.equal(parseStockInfo('999991', { prdt_abrv_name: '나', scty_grp_id_cd: 'ST', kosdaq_mket_lstg_dt: '20200101', scts_mket_lstg_dt: '' }).exchange, 'KOSDAQ');
  assert.equal(parseStockInfo('999992', { prdt_abrv_name: 'ETF', scty_grp_id_cd: 'EF', scts_mket_lstg_dt: '20200101' }), null);
  assert.equal(parseStockInfo('999993', { prdt_abrv_name: '폐지', scty_grp_id_cd: 'ST', scts_mket_lstg_dt: '20200101', lstg_abol_dt: '20260101' }), null);
  assert.equal(parseStockInfo('999994', { prdt_abrv_name: '', scty_grp_id_cd: 'ST', scts_mket_lstg_dt: '20200101' }), null);
  assert.deepEqual(parseHolidays([{ bass_dt: 'bad', opnd_yn: 'Y' }, { bass_dt: '20261105', opnd_yn: '?' }]), []);
  assert.equal(kstToIso('20261104', '090000'), '2026-11-04T00:00:00.000Z');
});

// ───────── Alpaca ─────────
test('Alpaca 스냅샷·분봉(페이지 이어 받기)·종목', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), h: new Headers(init.headers) });
    if (u.pathname === '/v2/stocks/snapshots') return res(fx('alpaca-snapshots.json'));
    if (u.pathname === '/v2/stocks/bars') return res(u.searchParams.get('page_token') ? fx('alpaca-bars-page2.json') : fx('alpaca-bars-page1.json'));
    if (u.pathname === '/v2/assets/TSTA') return res(fx('alpaca-asset.json'));
    return res({ message: 'not found' }, 404);
  };
  const a = createAlpaca({ keyId: 'id', secretKey: 'sec', transport: fetch });
  const s = await a.snapshots(['TSTA', 'TSTB']);
  assert.deepEqual(s.TSTA, { price: 200.5, quote_at: '2026-11-03T20:59:59.000Z', open: 198, high: 201, low: 197.5, volume: 12345, prev_close: 199, daily_t: '2026-11-03T05:00:00.000Z' });
  assert.equal(s.TSTB, undefined, '거래 없는 종목은 빠짐');
  assert.equal(calls[0].q.feed, 'iex');
  assert.equal(calls[0].h.get('APCA-API-KEY-ID'), 'id');
  const b = await a.bars(['TSTA'], '1Min', '2026-11-03T20:45:00Z');
  assert.equal(b.TSTA.length, 3);
  assert.equal(calls.filter((c) => c.path === '/v2/stocks/bars').length, 2);
  assert.equal(calls.at(-1).q.page_token, 'P2');
  assert.deepEqual(await a.asset('TSTA'), { market: 'US', symbol: 'TSTA', name: 'Test Alpha Inc.', exchange: 'NASDAQ', currency: 'USD' });
  assert.equal(await a.asset('NOPE'), null, '404 → null');
  assert.equal(await a.asset('bad sym'), null, '형식이 틀리면 호출 안 함');
  assert.equal(parseAsset({ symbol: 'X', class: 'crypto', status: 'active' }), null);
  assert.equal(parseAsset({ symbol: 'X', name: 'X', class: 'us_equity', status: 'active', exchange: 'ARCA' }).exchange, 'NYSE_ARCA');
});

// ───────── 수출입은행 ─────────
test('수출입은행 매매기준율: 콤마 숫자, 고시 전 빈 배열은 null, 인증 오류는 예외', async () => {
  assert.equal(parseUsdKrw(fx('koreaexim-ok.json')), 1401.5);
  assert.equal(parseUsdKrw([]), null);
  assert.throws(() => parseUsdKrw(fx('koreaexim-badkey.json')), /result 3/);
  const calls = [];
  const e = createExim({ authKey: 'k', transport: async (url) => { calls.push(url); return res(fx('koreaexim-ok.json')); } });
  assert.equal(await e.usdkrw('20261104'), 1401.5);
  assert.match(calls[0], /^https:\/\/oapi\.koreaexim\.go\.kr\/site\/program\/financial\/exchangeJSON\?authkey=k&searchdate=20261104&data=AP01$/);
});

// ───────── 모드 분기 ─────────
test('kr_quote_mode 분기: realtime → KIS(1m), 그 밖의 값 → 지연(1d)', () => {
  assert.deepEqual(krPlan(parseKrMode('realtime')), { provider: 'kis', fillBasis: '1m', source: 'kis' });
  assert.equal(krPlan(parseKrMode('delayed')).provider, 'delayed');
  assert.equal(krPlan(parseKrMode('REALTIME')).provider, 'delayed', '모르는 값은 안전한 쪽');
  assert.equal(krPlan(parseKrMode(undefined)).fillBasis, '1d');
});

test('kr_quote_mode 를 읽는 코드는 providers/index.ts 한 곳', () => {
  const files = ['jobs.ts', 'server.ts', 'providers/kis.ts', 'providers/alpaca.ts', 'providers/koreaexim.ts', 'providers/delayed.ts'];
  for (const f of files) {
    const src = readFileSync(new URL(`../../supabase/functions/_shared/${f}`, import.meta.url), 'utf8');
    assert.equal(/===?\s*'realtime'|'realtime'\s*===?/.test(src), false, f);
  }
});

// ───────── cron 토큰 ─────────
test('cron 토큰: 같을 때만 통과, 저장값이 없거나 짧으면 거부', async () => {
  const kv = new MemoryKv();
  const req = (t) => new Request('https://fn.test/x', { method: 'POST', headers: t ? { 'x-cron-token': t } : {} });
  assert.equal(await verifyCronToken(kv, req('a'.repeat(64))), false, '저장값 없음');
  await kv.set('cron_token', 'short', null);
  assert.equal(await verifyCronToken(kv, req('short')), false, '짧은 저장값');
  const tok = 'f'.repeat(64);
  await kv.set('cron_token', tok, null);
  assert.equal(await verifyCronToken(kv, req(tok)), true);
  assert.equal(await verifyCronToken(kv, req('e'.repeat(64))), false);
  assert.equal(await verifyCronToken(kv, req(null)), false);
  assert.equal(safeEqual('abc', 'abd'), false);
});
