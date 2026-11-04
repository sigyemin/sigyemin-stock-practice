// place-order / cancel-order 처리(입력 검사·오류 전달). 체결 판단은 DB 함수 — tests/sql/orders.test.sql
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceHandler, createCancelHandler, parseOrder } from '../../supabase/functions/place-order/handler.ts';

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    d: {
      allowedOrigins: [],
      getCaller: async (jwt) => (jwt === 'tok' ? { participantId: 1, canFundBot: true } : jwt === 'unreg' ? null : 'invalid'),
      placeOrder: async (jwt, o) => { calls.push(o); return { data: { ok: true, status: 'filled', dry_run: o.dry_run } }; },
      cancelOrder: async (jwt, id) => { calls.push(id); return { data: { ok: true, order_id: id, status: 'cancelled' } }; },
      ...over,
    },
  };
}
const post = (h, token, body) => h(new Request('https://fn.test/x', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }))
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('주문 입력 검사', () => {
  const ok = { market: 'KR', symbol: '999990', side: 'buy', type: 'limit', qty: 10, limit: 70000 };
  assert.deepEqual(parseOrder(ok), { ...ok, limit: '70000', dry_run: false });
  assert.equal(parseOrder({ ...ok, symbol: 'tsta', market: 'US', limit: '199.99' }).symbol, 'TSTA');
  const bad = [
    [{ ...ok, market: 'JP' }, 'invalid_market'], [{ ...ok, symbol: '12345' }, 'invalid_symbol'], [{ ...ok, side: 'short' }, 'invalid_side'],
    [{ ...ok, type: 'stop' }, 'invalid_type'], [{ ...ok, qty: 1.5 }, 'invalid_qty'], [{ ...ok, qty: 0 }, 'invalid_qty'], [{ ...ok, qty: '10' }, 'invalid_qty'],
    [{ ...ok, limit: -1 }, 'invalid_limit'], [{ ...ok, limit: '1e3' }, 'invalid_limit'], [{ ...ok, limit: 'NaN' }, 'invalid_limit'],
    [{ ...ok, type: 'market' }, 'invalid_limit'],
  ];
  for (const [b, e] of bad) assert.equal(parseOrder(b), e, JSON.stringify(b));
  assert.equal(parseOrder({ ...ok, type: 'market', limit: null }).limit, null);
});

test('place-order: 인증·dry_run 전달·DB 오류 코드 전달', async () => {
  const { d, calls } = deps();
  const h = createPlaceHandler(d);
  const body = { market: 'KR', symbol: '999990', side: 'buy', type: 'market', qty: 1, dry_run: true };
  assert.equal((await post(h, null, body)).status, 401);
  assert.equal((await post(h, 'bad', body)).status, 401);
  assert.equal((await post(h, 'unreg', body)).status, 403);
  const r = await post(h, 'tok', body);
  assert.deepEqual([r.status, r.body.dry_run, calls[0].dry_run], [200, true, true]);
  assert.equal((await post(h, 'tok', { ...body, qty: -1 })).body.error, 'invalid_qty');
  for (const [code, msg, status, err] of [['22023', 'insufficient_funds', 400, 'insufficient_funds'], ['22023', 'quote_stale', 400, 'quote_stale'],
    ['42501', 'forbidden', 403, 'forbidden'], ['22023', 'rate_missing:X', 400, 'server_error'], ['XX000', 'boom', 500, 'server_error']]) {
    const e = deps({ placeOrder: async () => ({ errorCode: code, message: msg }) });
    const x = await post(createPlaceHandler(e.d), 'tok', body);
    assert.deepEqual([x.status, x.body.error], [status, err], msg);
  }
});

test('cancel-order: 주문 번호 검사, 결과 전달', async () => {
  const { d, calls } = deps();
  const h = createCancelHandler(d);
  assert.equal((await post(h, 'tok', { order_id: 'x' })).body.error, 'invalid_order_id');
  assert.equal((await post(h, 'tok', { order_id: 0 })).status, 400);
  const r = await post(h, 'tok', { order_id: 7 });
  assert.deepEqual([r.status, r.body.status, calls[0]], [200, 'cancelled', 7]);
  const e = deps({ cancelOrder: async () => ({ errorCode: '42501', message: 'not_found' }) });
  assert.deepEqual((await post(createCancelHandler(e.d), 'tok', { order_id: 7 })).body, { ok: false, error: 'not_found' });
});
