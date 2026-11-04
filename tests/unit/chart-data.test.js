import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toKLine, aggregate, drawingToOverlay, overlayToPoints, quoteStatus, sourceText, TOOL_TO_OVERLAY, OVERLAY_TO_TOOL } from '../../app/js/chart-data.js';

test('DB 봉 → 차트 데이터(정렬, 잘못된 행 버림)', () => {
  const k = toKLine([
    { t: '2026-11-04T01:01:00Z', o: '2', h: '3', l: '1', c: '2', v: null },
    { t: '2026-11-04T01:00:00Z', o: 1, h: 2, l: 1, c: 2, v: 5 },
    { t: 'bad', o: 1, h: 1, l: 1, c: 1 },
  ]);
  assert.equal(k.length, 2);
  assert.equal(k[0].timestamp, Date.parse('2026-11-04T01:00:00Z'));
  assert.equal(k[1].volume, 0);
});

test('1분봉 → 5분봉', () => {
  const t0 = Date.parse('2026-11-04T01:00:00Z');
  const bars = [0, 1, 2, 3, 4, 5].map((i) => ({ timestamp: t0 + i * 60000, open: 10 + i, high: 20 + i, low: 5 - i, close: 11 + i, volume: 1 }));
  const five = aggregate(bars, 5);
  assert.equal(five.length, 2);
  assert.deepEqual(five[0], { timestamp: t0, open: 10, high: 24, low: 1, close: 15, volume: 5 });
  assert.deepEqual(five[1], { timestamp: t0 + 300000, open: 15, high: 25, low: 0, close: 16, volume: 1 });
});

test('그림 ↔ 도형 변환은 왕복해도 같다', () => {
  const d = { tool: 'trendline', points: [{ t: '2026-11-02T00:00:00.000Z', p: 70000 }, { t: '2026-11-03T00:00:00.000Z', p: 71000 }], label: '' };
  const o = drawingToOverlay(d);
  assert.equal(o.name, 'segment');
  assert.deepEqual(overlayToPoints(o.points), d.points);
  assert.deepEqual(overlayToPoints([{ value: 5 }]), [{ p: 5 }], '시간 없는 점(수평선)');
  assert.equal(overlayToPoints(Array.from({ length: 12 }, (_, i) => ({ value: i }))).length, 10, '최대 10점');
  assert.equal(drawingToOverlay({ tool: 'rect', points: [{ p: 1 }] }), null, '지원 안 하는 도구');
  for (const [tool, name] of Object.entries(TOOL_TO_OVERLAY)) assert.equal(OVERLAY_TO_TOOL[name], tool);
});

test('시세 배지 상태', () => {
  const now = Date.parse('2026-11-04T01:05:00Z');
  const q = (at, mode = 'realtime') => ({ quote_at: at, mode });
  assert.equal(quoteStatus(null, { now, maxAgeSec: 120, marketOpen: true }), 'none');
  assert.equal(quoteStatus(q('2026-11-04T01:04:00Z'), { now, maxAgeSec: 120, marketOpen: true }), 'fresh');
  assert.equal(quoteStatus(q('2026-11-04T01:02:00Z'), { now, maxAgeSec: 120, marketOpen: true }), 'stale');
  assert.equal(quoteStatus(q('2026-11-04T01:02:00Z'), { now, maxAgeSec: 120, marketOpen: false }), 'closed');
  assert.equal(quoteStatus(q('2026-11-04T01:04:00Z', 'delayed'), { now, maxAgeSec: 120, marketOpen: true }), 'delayed');
  assert.match(sourceText('KR', { mode: 'delayed' }), /한국거래소 통계정보/);
  assert.match(sourceText('US', null), /IEX/);
});

test('화면용 장 시간 판단이 서버 구현과 같다', async () => {
  const web = await import('../../app/js/market-time.js');
  const srv = await import('../../supabase/functions/_shared/market-time.ts');
  const rows = [null,
    { trade_date: '2026-11-27', is_open: true, open_at: null, close_at: '2026-11-27T18:00:00Z' },
    { trade_date: '2026-11-26', is_open: false, open_at: null, close_at: null }];
  const start = Date.parse('2026-10-29T00:00:00Z');
  for (let t = start; t < start + 32 * 86400000; t += 17 * 60000) {
    const now = new Date(t);
    for (const row of rows) {
      assert.equal(web.isMarketOpen('US', now, row), srv.isNyseOpen(now, row), `US ${now.toISOString()}`);
      assert.equal(web.isMarketOpen('KR', now, row), srv.isKrxOpen(now, row), `KR ${now.toISOString()}`);
    }
  }
});
