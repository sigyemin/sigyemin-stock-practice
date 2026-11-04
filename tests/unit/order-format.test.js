import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costRows, previewSummary, holdingView, STATUS_TEXT, ORDER_ERRORS } from '../../app/js/order-format.js';
import { KNOWN_ERRORS } from '../../supabase/functions/place-order/handler.ts';

test('비용 줄: 국내 매도는 세금 줄, 미국 매도는 SEC·FINRA 줄, 매수는 세금 줄 없음', () => {
  const kr = costRows('KR', 'sell', { gross: 700000, broker_fee: 98, reg_fee: 25, tx_tax: 1400, cash_delta: 698477 });
  assert.deepEqual(kr, [['체결금액', '700,000원'], ['위탁 수수료', '98원'], ['유관기관 제비용', '25원'], ['거래세·농특세', '1,400원'], ['계좌로 들어오는 돈', '698,477원']]);
  const us = costRows('US', 'sell', { gross: 2000, broker_fee: 5, reg_fee: 0.05, tx_tax: 0, cash_delta: 1994.95 });
  assert.deepEqual(us.map((r) => r[0]), ['체결금액', '위탁 수수료', 'SEC·FINRA 수수료', '계좌로 들어오는 돈']);
  assert.equal(us.at(-1)[1], '$1,994.95');
  const buy = costRows('KR', 'buy', { gross: 700000, broker_fee: 98, reg_fee: 25, tx_tax: 0, cash_delta: -700123 });
  assert.deepEqual(buy.at(-1), ['계좌에서 나가는 돈', '700,123원']);
  assert.equal(buy.some((r) => r[0] === '거래세·농특세'), false);
});

test('미리보기 문구·보유 평가', () => {
  assert.match(previewSummary({ status: 'filled' }), /바로 체결/);
  assert.match(previewSummary({ status: 'reserved', fill_basis: '1m', trade_date: '2026-11-05' }), /예약.*2026-11-05/);
  assert.match(previewSummary({ status: 'open', fill_basis: '1d', trade_date: '2026-11-06' }), /지연 모드/);
  assert.deepEqual(holdingView({ qty: '10', cost_local_open: '700123' }, 71000), { qty: 10, avg: 70012.3, cost: 700123, value: 710000, pnl: 9877 });
  assert.equal(holdingView({ qty: 1, cost_local_open: 1 }, null).pnl, null);
  assert.equal(Object.keys(STATUS_TEXT).length, 6);
});

test('서버가 화면에 넘기는 오류 코드는 모두 한국어 안내가 있다', () => {
  for (const code of KNOWN_ERRORS) {
    if (['invalid_side', 'invalid_type', 'forbidden'].includes(code)) continue; // 화면 입력으로는 생기지 않음
    assert.ok(ORDER_ERRORS[code], code);
  }
});

test('DB 가 기록하는 거부 사유(reject_reason)마다 한국어 안내가 있다(리뷰 U2)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const codes = new Set();
  for (const f of readdirSync(dir)) {
    for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/reject_reason\s*=\s*'([a-z_]+)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.size >= 4, [...codes].join(','));
  for (const c of codes) assert.ok(ORDER_ERRORS[c], c);
});
