// fund-grant 처리 로직 시험(가짜 DB). 합성 토큰만 사용.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../supabase/functions/fund-grant/handler.ts';

const ORIGIN = 'https://example.test';
const CALLERS = {
  'tok-min': { participantId: 1, canFundBot: true },
  'tok-ppo': { participantId: 2, canFundBot: false },
  'tok-unreg': null,
};
const KINDS = { 1: 'human', 2: 'human', 3: 'bot' };

function makeHandler() {
  const calls = [];
  const balances = { '1:KRW': 10000000, '2:KRW': 10000000, '3:KRW': 10000000, '1:USD': 10000, '2:USD': 10000, '3:USD': 10000 };
  const handler = createHandler({
    allowedOrigins: [ORIGIN],
    getCaller: async (jwt) => (jwt in CALLERS ? CALLERS[jwt] : 'invalid'),
    getParticipantKind: async (_jwt, id) => KINDS[id] ?? null,
    getLimits: async () => ({ KRW: 100000000, USD: 100000 }),
    requestFund: async (jwt, to, currency, amount) => {
      calls.push({ jwt, to, currency, amount });
      balances[`${to}:${currency}`] += Number(amount);
      return { balance: balances[`${to}:${currency}`] };
    },
  });
  return { handler, calls };
}

function req(token, body, method = 'POST') {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://fn.test/fund-grant', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

async function call(h, token, body) {
  const res = await h(req(token, body));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('민 → 봇 성공', async () => {
  const { handler, calls } = makeHandler();
  const r = await call(handler, 'tok-min', { to: 3, currency: 'KRW', amount: 1000000 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, participant_id: 3, currency: 'KRW', balance: 11000000 });
  assert.equal(calls.length, 1);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('뽀 → 봇 403', async () => {
  const { handler, calls } = makeHandler();
  const r = await call(handler, 'tok-ppo', { to: 3, currency: 'KRW', amount: 1000 });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'forbidden_target');
  assert.equal(calls.length, 0);
});

test('뽀 → 뽀 성공(USD 소수 2자리)', async () => {
  const { handler } = makeHandler();
  const r = await call(handler, 'tok-ppo', { to: 2, currency: 'USD', amount: 500.25 });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, 10500.25);
});

test('남에게(민 → 뽀, 뽀 → 민) 403', async () => {
  const { handler } = makeHandler();
  assert.equal((await call(handler, 'tok-min', { to: 2, currency: 'KRW', amount: 1000 })).status, 403);
  assert.equal((await call(handler, 'tok-ppo', { to: 1, currency: 'KRW', amount: 1000 })).status, 403);
});

test('미등록 JWT 403, 잘못된 JWT 401, 토큰 없음 401', async () => {
  const { handler, calls } = makeHandler();
  const a = await call(handler, 'tok-unreg', { to: 1, currency: 'KRW', amount: 1000 });
  assert.equal(a.status, 403);
  assert.equal(a.body.error, 'not_registered');
  assert.equal((await call(handler, 'tok-forged', { to: 1, currency: 'KRW', amount: 1000 })).status, 401);
  assert.equal((await call(handler, null, { to: 1, currency: 'KRW', amount: 1000 })).status, 401);
  assert.equal(calls.length, 0);
});

test('음수·0·소수 원·소수 3자리 달러·상한 초과·잘못된 값 400', async () => {
  const { handler, calls } = makeHandler();
  const bad = [
    { to: 1, currency: 'KRW', amount: -1000 },
    { to: 1, currency: 'KRW', amount: 0 },
    { to: 1, currency: 'KRW', amount: 1.5 },
    { to: 1, currency: 'USD', amount: 1.005 },
    { to: 1, currency: 'KRW', amount: 100000001 },
    { to: 1, currency: 'USD', amount: 100000.01 },
    { to: 1, currency: 'EUR', amount: 1000 },
    { to: 1, currency: 'KRW', amount: '1e3' },
    { to: 1, currency: 'KRW' },
    { to: '1', currency: 'KRW', amount: 1000 },
    { to: 9, currency: 'KRW', amount: 1000 },
  ];
  for (const b of bad) {
    const r = await call(handler, 'tok-min', b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(calls.length, 0);
});

test('본문이 JSON 이 아니면 400, GET 은 405, OPTIONS 는 204', async () => {
  const { handler } = makeHandler();
  const r1 = await handler(new Request('https://fn.test/fund-grant', {
    method: 'POST', headers: { Authorization: 'Bearer tok-min' }, body: 'not json',
  }));
  assert.equal(r1.status, 400);
  assert.equal((await handler(req('tok-min', null, 'GET'))).status, 405);
  const r3 = await handler(req(null, null, 'OPTIONS'));
  assert.equal(r3.status, 204);
});

test('허용되지 않은 Origin 에는 CORS 허용 헤더 없음', async () => {
  const { handler } = makeHandler();
  const res = await handler(new Request('https://fn.test/fund-grant', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.test' },
  }));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('DB 가 거부하면(이중 방어) 403/400 으로 전달', async () => {
  for (const [code, status] of [['42501', 403], ['22023', 400], ['XX000', 500]]) {
    const handler = createHandler({
      allowedOrigins: [],
      getCaller: async () => ({ participantId: 1, canFundBot: true }),
      getParticipantKind: async () => 'human',
      getLimits: async () => ({ KRW: 100000000, USD: 100000 }),
      requestFund: async () => ({ errorCode: code }),
    });
    const r = await call(handler, 'tok', { to: 1, currency: 'KRW', amount: 1000 });
    assert.equal(r.status, status);
  }
});
