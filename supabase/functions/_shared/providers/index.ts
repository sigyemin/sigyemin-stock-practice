// 한국 시세 공급자 선택 — kr_quote_mode 를 읽는 분기는 이 파일 한 곳뿐.
//   'realtime' → KIS(tick-kr 가 1분마다 수집)
//   'delayed'  → 지연 모드(KRX·data.go.kr). M2 에서는 자리만(delayed.ts)
// 모드 값 자체는 DB(sp.app_settings)가 기준. 마이그레이션은 값을 바꾸지 않는다.

export type KrMode = 'realtime' | 'delayed';

export function parseKrMode(value: unknown): KrMode {
  return value === 'realtime' ? 'realtime' : 'delayed'; // 모르는 값이면 안전한 쪽(외부 호출 없는 지연 모드)
}

export type KrPlan =
  | { provider: 'kis'; fillBasis: '1m'; source: 'kis' }
  | { provider: 'delayed'; fillBasis: '1d'; source: 'krx_openapi' };

export function krPlan(mode: KrMode): KrPlan {
  return mode === 'realtime'
    ? { provider: 'kis', fillBasis: '1m', source: 'kis' }
    : { provider: 'delayed', fillBasis: '1d', source: 'krx_openapi' };
}
