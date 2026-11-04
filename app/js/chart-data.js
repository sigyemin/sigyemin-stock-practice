// 차트용 순수 함수(브라우저·Node 시험 공용). DOM·라이브러리에 의존하지 않는다.

// DB candles 행 → KLineChart 데이터
export function toKLine(rows) {
  return (rows ?? [])
    .map((r) => ({
      timestamp: Date.parse(r.t),
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: r.v === null || r.v === undefined ? 0 : Number(r.v),
    }))
    .filter((k) => Number.isFinite(k.timestamp) && [k.open, k.high, k.low, k.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// 1분봉 → 5분봉(구간 시작 시각 기준, 시·고·저·종·거래량)
export function aggregate(bars, minutes) {
  const ms = minutes * 60000;
  const out = [];
  for (const b of bars) {
    const start = Math.floor(b.timestamp / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.timestamp === start) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ timestamp: start, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
  }
  return out;
}

// 우리 그림 종류 ↔ KLineChart 기본 도형 이름(그림 저장 형식은 라이브러리와 무관: {tool, points:[{t,p}]})
export const TOOL_TO_OVERLAY = {
  trendline: 'segment',
  ray: 'rayLine',
  hline: 'horizontalStraightLine',
  vline: 'verticalStraightLine',
  fib: 'fibonacciLine',
  text: 'simpleAnnotation',
};
export const OVERLAY_TO_TOOL = Object.fromEntries(Object.entries(TOOL_TO_OVERLAY).map(([k, v]) => [v, k]));

export function drawingToOverlay(d) {
  const name = TOOL_TO_OVERLAY[d.tool];
  if (!name || !Array.isArray(d.points)) return null;
  const points = d.points
    .map((p) => ({ timestamp: p.t ? Date.parse(p.t) : undefined, value: Number(p.p) }))
    .filter((p) => Number.isFinite(p.value));
  if (points.length === 0) return null;
  return { name, points, extendData: d.label ?? '' };
}

// 도형 점 → 저장할 점(시간은 ISO, 값은 숫자). 점은 최대 10개(스키마 check)
export function overlayToPoints(points) {
  return (points ?? [])
    .filter((p) => Number.isFinite(p?.value))
    .slice(0, 10)
    .map((p) => (Number.isFinite(p.timestamp) ? { t: new Date(p.timestamp).toISOString(), p: p.value } : { p: p.value }));
}

// 시세 상태 배지: 'none'(시세 없음) | 'delayed'(지연 모드) | 'stale'(장중인데 오래됨) | 'fresh' | 'closed'(장 밖, 마지막 값)
export function quoteStatus(quote, { now, maxAgeSec, marketOpen }) {
  if (!quote) return 'none';
  if (quote.mode === 'delayed') return 'delayed';
  if (!marketOpen) return 'closed';
  const age = (now - Date.parse(quote.quote_at)) / 1000;
  return Number.isFinite(age) && age <= maxAgeSec ? 'fresh' : 'stale';
}

export const STATUS_TEXT = {
  none: '시세 없음',
  delayed: '지연 시세',
  stale: '시세 늦음',
  fresh: '실시간',
  closed: '장 마감',
  error: '불러오기 실패',
};

// 출처 표기(공급자 약관상 표시해야 하는 문구 포함)
export function sourceText(market, quote) {
  if (market === 'US') return '시세: Alpaca Market Data (IEX 단일 거래소)';
  if (quote?.mode === 'delayed') return '출처: 한국거래소 통계정보';
  return '시세: 한국투자증권 Open API';
}

export const KR_CODE = /^[0-9]{6}$/;
export const US_TICKER = /^[A-Za-z][A-Za-z.]{0,9}$/;
