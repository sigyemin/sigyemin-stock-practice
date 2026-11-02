import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorWon, ceilCent, roundCent, isValidAmount } from '../../supabase/functions/_shared/money.ts';

test('원 미만 절사', () => {
  assert.equal(floorWon(98.37), 98);
  assert.equal(floorWon('98.99'), 98);
  assert.equal(floorWon(100), 100);
  assert.equal(floorWon(-98.37), -99);
});

test('센트 미만 올림', () => {
  assert.equal(ceilCent(0.0412), 0.05);
  assert.equal(ceilCent(0.04), 0.04);
  assert.equal(ceilCent(1e-7), 0.01);
  assert.equal(ceilCent('12.3401'), 12.35);
});

test('센트 미만 반올림(0.5 는 위로)', () => {
  assert.equal(roundCent(5.005), 5.01); // 이진 부동소수로는 5.00499… 이지만 10진 값 기준
  assert.equal(roundCent(5.004), 5);
  assert.equal(roundCent(1.015), 1.02);
  assert.equal(roundCent('-5.005'), -5.01);
  assert.equal(roundCent(4.99), 4.99);
});

test('금액 형식 검사', () => {
  assert.equal(isValidAmount('KRW', 1000), true);
  assert.equal(isValidAmount('KRW', '1000'), true);
  assert.equal(isValidAmount('KRW', 1.5), false);
  assert.equal(isValidAmount('KRW', -1000), false);
  assert.equal(isValidAmount('KRW', 0), false);
  assert.equal(isValidAmount('USD', 500.25), true);
  assert.equal(isValidAmount('USD', 1.005), false);
  assert.equal(isValidAmount('USD', '1.50'), true);
  assert.equal(isValidAmount('USD', NaN), false);
  assert.equal(isValidAmount('USD', '1e3'), false);
  assert.equal(isValidAmount('EUR', 10), false);
  assert.equal(isValidAmount('KRW', null), false);
  assert.equal(isValidAmount('KRW', true), false);
});
