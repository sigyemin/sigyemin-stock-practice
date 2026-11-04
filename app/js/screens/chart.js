// 차트: 캔들·거래량·MA·RSI(KLineChart), 기간(1분·5분·일), 그리기 도구 → sp.drawings 저장·재표시.
// 라이브러리는 index.html 의 vendor UMD(전역 klinecharts). 우리 코드는 HTML 문자열을 넣지 않는다.
import { el } from '../dom.js';
import { formatMoney } from '../format.js';
import {
  toKLine, aggregate, drawingToOverlay, overlayToPoints, quoteStatus, STATUS_TEXT, sourceText, OVERLAY_TO_TOOL, TOOL_TO_OVERLAY,
} from '../chart-data.js';
import { isMarketOpen, marketDate, marketTimezone } from '../market-time.js';
import {
  getInstrument, loadQuote, loadCandles, loadCalendarRow, loadSetting, loadDrawings, saveDrawing, updateDrawingPoints, deleteDrawing,
} from '../market-api.js';

const TF = [
  { key: '1m', label: '1분', period: { type: 'minute', span: 1 }, src: '1m' },
  { key: '5m', label: '5분', period: { type: 'minute', span: 5 }, src: '1m' },
  { key: '1d', label: '일', period: { type: 'day', span: 1 }, src: '1d' },
];
const TOOLS = [
  { tool: 'trendline', label: '추세선' },
  { tool: 'ray', label: '반직선' },
  { tool: 'hline', label: '수평선' },
  { tool: 'vline', label: '수직선' },
  { tool: 'fib', label: '피보나치' },
];
const POLL_MS = 30000;

export function chartScreen(me, market, symbol) {
  const title = el('h1', { text: symbol });
  const price = el('p', { className: 'price', text: '-' });
  const badge = el('span', { className: 'badge', text: '…' });
  const source = el('p', { className: 'muted small' });
  const status = el('p', { className: 'notice', attrs: { role: 'status' } });
  const box = el('div', { className: 'chart', attrs: { id: 'kline' } });
  const tfBar = el('div', { className: 'row' });
  const toolBar = el('div', { className: 'row' });
  const othersToggle = el('input', { attrs: { type: 'checkbox', id: 'others' } });
  othersToggle.checked = true;
  const delBtn = el('button', { text: '선택한 그림 지우기', attrs: { type: 'button', disabled: 'true' } });

  let chart = null;
  let tf = TF[2];
  let maxAge = 120;
  let timer = null;
  let selected = null; // { overlayId, dbId }
  let disposed = false;
  const overlayDb = new Map(); // overlayId → { dbId, owner }

  function setStatus(s) {
    badge.textContent = STATUS_TEXT[s] ?? s;
    badge.className = `badge ${s}`;
  }

  async function refreshQuote() {
    try {
      const now = new Date();
      const [q, cal] = await Promise.all([loadQuote(market, symbol), loadCalendarRow(market, marketDate(market, now))]);
      if (disposed) return;
      price.textContent = q ? formatMoney(market === 'KR' ? 'KRW' : 'USD', q.price) : '-';
      setStatus(quoteStatus(q, { now: now.getTime(), maxAgeSec: maxAge, marketOpen: isMarketOpen(market, now, cal) }));
      source.textContent = sourceText(market, q);
    } catch {
      setStatus('error');
    }
  }

  async function bars() {
    const rows = await loadCandles(market, symbol, tf.src, tf.src === '1m' ? 1000 : 400);
    const k = toKLine(rows);
    return tf.key === '5m' ? aggregate(k, 5) : k;
  }

  function addOverlayFor(d) {
    const o = drawingToOverlay(d);
    if (!o) return;
    const mine = d.participant_id === me.participantId;
    const id = chart.createOverlay({
      ...o,
      lock: !mine,
      styles: mine ? null : { line: { color: '#8b949e', style: 'dashed' } },
      onSelected: (e) => {
        const info = overlayDb.get(e.overlay.id);
        selected = info && info.owner === me.participantId ? { overlayId: e.overlay.id, dbId: info.dbId } : null;
        delBtn.disabled = !selected;
      },
      onDeselected: () => {
        selected = null;
        delBtn.disabled = true;
      },
      onPressedMoveEnd: async (e) => {
        const info = overlayDb.get(e.overlay.id);
        if (!info || info.owner !== me.participantId) return;
        try {
          await updateDrawingPoints(info.dbId, overlayToPoints(e.overlay.points));
        } catch {
          status.textContent = '그림을 저장하지 못했습니다.';
        }
      },
    });
    if (id) overlayDb.set(id, { dbId: d.id, owner: d.participant_id });
  }

  async function loadOverlays() {
    for (const id of overlayDb.keys()) chart.removeOverlay({ id });
    overlayDb.clear();
    try {
      const list = await loadDrawings(market, symbol, tf.key);
      for (const d of list) if (othersToggle.checked || d.participant_id === me.participantId) addOverlayFor(d);
    } catch {
      status.textContent = '그림을 불러오지 못했습니다.';
    }
  }

  async function reload() {
    if (!chart) return;
    chart.setPeriod(tf.period); // DataLoader 가 다시 불린다
    await loadOverlays();
  }

  function startDrawing(tool) {
    if (!chart) return;
    status.textContent = `${TOOLS.find((t) => t.tool === tool)?.label ?? ''}: 차트에서 점을 찍어 그리세요.`;
    chart.createOverlay({
      name: TOOL_TO_OVERLAY[tool],
      onDrawEnd: async (e) => {
        const tool2 = OVERLAY_TO_TOOL[e.overlay.name];
        const points = overlayToPoints(e.overlay.points);
        try {
          const row = await saveDrawing({ participant_id: me.participantId, market, symbol, tf: tf.key, tool: tool2, points });
          status.textContent = '그림을 저장했습니다.';
          chart.removeOverlay({ id: e.overlay.id });
          addOverlayFor({ id: row.id, participant_id: me.participantId, tool: tool2, points, label: '' });
        } catch {
          status.textContent = '그림을 저장하지 못했습니다.';
          chart.removeOverlay({ id: e.overlay.id });
        }
      },
    });
  }

  for (const t of TF) {
    tfBar.append(el('button', {
      text: t.label,
      className: t.key === tf.key ? 'on' : '',
      attrs: { type: 'button', 'aria-pressed': String(t.key === tf.key) },
      on: {
        click: (ev) => {
          tf = t;
          for (const b of tfBar.children) {
            b.className = '';
            b.setAttribute('aria-pressed', 'false');
          }
          ev.currentTarget.className = 'on';
          ev.currentTarget.setAttribute('aria-pressed', 'true');
          reload();
        },
      },
    }));
  }
  for (const t of TOOLS) toolBar.append(el('button', { text: t.label, attrs: { type: 'button' }, on: { click: () => startDrawing(t.tool) } }));
  toolBar.append(delBtn);
  delBtn.addEventListener('click', async () => {
    if (!selected) return;
    const s = selected;
    try {
      await deleteDrawing(s.dbId);
      chart.removeOverlay({ id: s.overlayId });
      overlayDb.delete(s.overlayId);
      selected = null;
      delBtn.disabled = true;
    } catch {
      status.textContent = '그림을 지우지 못했습니다.';
    }
  });
  othersToggle.addEventListener('change', loadOverlays);

  const node = el('section', {}, [
    el('p', {}, [el('a', { text: '← 종목', attrs: { href: '#/search' } })]),
    el('div', { className: 'row between' }, [title, badge]),
    price,
    tfBar,
    box,
    el('div', { className: 'row' }, [othersToggle, el('label', { text: '다른 참가자 그림 보기', attrs: { for: 'others' } })]),
    toolBar,
    status,
    source,
  ]);

  // 화면에 붙은 뒤 차트 생성
  queueMicrotask(async () => {
    if (!globalThis.klinecharts) {
      status.textContent = '차트 라이브러리를 불러오지 못했습니다.';
      return;
    }
    try {
      const [inst, age] = await Promise.all([getInstrument(market, symbol), loadSetting('quote_max_age_sec')]);
      if (disposed) return;
      if (!inst) {
        status.textContent = '추가되지 않은 종목입니다. 종목 화면에서 추가해 주세요.';
        return;
      }
      title.textContent = `${inst.name} (${inst.symbol})`;
      maxAge = Number(age) || 120;
      // 한국식 색: 오르면 빨강, 내리면 파랑
      const UP = '#d1242f';
      const DOWN = '#0969da';
      chart = globalThis.klinecharts.init(box, {
        locale: 'ko-KR',
        timezone: marketTimezone(market),
        styles: {
          candle: { bar: { upColor: UP, downColor: DOWN, upBorderColor: UP, downBorderColor: DOWN, upWickColor: UP, downWickColor: DOWN } },
        },
      });
      chart.setSymbol({ ticker: `${market}:${symbol}`, pricePrecision: market === 'KR' ? 0 : 2, volumePrecision: 0 });
      chart.setDataLoader({
        getBars: async ({ type, callback }) => {
          if (type !== 'init') return callback([], false);
          try {
            const data = await bars();
            callback(data, false);
            if (data.length === 0) status.textContent = '아직 봉 데이터가 없습니다.';
          } catch {
            callback([], false);
            setStatus('error');
          }
        },
      });
      chart.createIndicator({ name: 'MA', paneId: 'candle_pane', calcParams: [20, 60] }, true);
      chart.createIndicator('VOL');
      chart.createIndicator('RSI');
      chart.setPeriod(tf.period);
      await loadOverlays();
      await refreshQuote();
      timer = setInterval(() => {
        refreshQuote();
        if (tf.src === '1m') chart.resetData();
      }, POLL_MS);
    } catch {
      status.textContent = '차트를 준비하지 못했습니다.';
    }
  });

  node._cleanup = () => {
    disposed = true;
    clearInterval(timer);
    if (chart) globalThis.klinecharts.dispose(box);
  };
  return node;
}
