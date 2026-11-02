import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKRW, formatUSD, formatMoney } from '../../app/js/format.js';

test('원화 표시', () => {
  assert.equal(formatKRW(10000000), '10,000,000원');
  assert.equal(formatKRW('-5000'), '-5,000원');
  assert.equal(formatKRW(undefined), '-');
});

test('달러 표시', () => {
  assert.equal(formatUSD(10000), '$10,000.00');
  assert.equal(formatUSD('10500.25'), '$10,500.25');
  assert.equal(formatUSD(-1.5), '-$1.50');
  assert.equal(formatMoney('USD', 1), '$1.00');
  assert.equal(formatMoney('KRW', 1), '1원');
});
