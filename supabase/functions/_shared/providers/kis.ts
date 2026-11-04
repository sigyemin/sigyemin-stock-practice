// 한국투자증권 KIS Developers — 시세 조회만.
// 근거: 공식 예제 저장소 github.com/koreainvestment/open-trading-api (examples_llm, 2026-10-28 커밋 3a9be59 기준)
//   - 실전 도메인 https://openapi.koreainvestment.com:9443 (kis_auth.py)
//   - 토큰 POST /oauth2/tokenP, "유효기간 1일, 6시간 이내 발급시 기존 token값 유지, 발급시 알림톡 무조건 발송" (kis_auth.py 주석)
//   - 현재가 FHKST01010100, 당일 분봉 FHKST03010200(1회 최대 30건, 당일만), 일봉 FHKST03010100(1회 최대 100건),
//     휴장일 CTCA0903R("가급적 1일 1회"), 주식기본조회 CTPF1002R
// 주문·잔고·계좌 경로와 TR ID 는 이 파일에 없다. 계좌번호도 쓰지 않는다.
import { guardedFetch, type AllowRule, type FetchLike } from '../http.ts';
import type { KvStore } from '../kv.ts';

export const KIS_ORIGIN = 'https://openapi.koreainvestment.com:9443';

export const KIS_TR = {
  price: 'FHKST01010100',
  minute: 'FHKST03010200',
  daily: 'FHKST03010100',
  holiday: 'CTCA0903R',
  stockInfo: 'CTPF1002R',
} as const;

const Q = '/uapi/domestic-stock/v1/quotations';
export const KIS_PATHS = {
  token: '/oauth2/tokenP',
  price: `${Q}/inquire-price`,
  minute: `${Q}/inquire-time-itemchartprice`,
  daily: `${Q}/inquire-daily-itemchartprice`,
  holiday: `${Q}/chk-holiday`,
  stockInfo: `${Q}/search-stock-info`,
} as const;

export const KIS_ALLOW: AllowRule[] = [
  { method: 'POST', origin: KIS_ORIGIN, path: KIS_PATHS.token },
  { method: 'GET', origin: KIS_ORIGIN, path: KIS_PATHS.price, trIds: [KIS_TR.price] },
  { method: 'GET', origin: KIS_ORIGIN, path: KIS_PATHS.minute, trIds: [KIS_TR.minute] },
  { method: 'GET', origin: KIS_ORIGIN, path: KIS_PATHS.daily, trIds: [KIS_TR.daily] },
  { method: 'GET', origin: KIS_ORIGIN, path: KIS_PATHS.holiday, trIds: [KIS_TR.holiday] },
  { method: 'GET', origin: KIS_ORIGIN, path: KIS_PATHS.stockInfo, trIds: [KIS_TR.stockInfo] },
];

// 토큰 재사용 규칙(우리 쪽)
export const TOKEN_REUSE_MARGIN_MS = 30 * 60 * 1000; // 만료 30분 전부터는 새로 발급
export const TOKEN_ISSUE_MIN_GAP_MS = 65 * 1000; // 발급 시도 간격 최소 65초(발급할 때마다 알림톡이 가므로 연속 발급 방지)

export class KisError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'KisError';
  }
}

export type KisDeps = {
  appKey: string;
  appSecret: string;
  kv: KvStore;
  fetch: FetchLike; // 실제 fetch. 아래에서 allowlist 로 감싼다
  now?: () => Date;
};

export function createKis(deps: KisDeps) {
  const now = deps.now ?? (() => new Date());
  const f = guardedFetch(KIS_ALLOW, deps.fetch);

  async function issueToken(): Promise<string> {
    const last = await deps.kv.get('kis_token_issue_at');
    if (last && now().getTime() - Date.parse(last.value) < TOKEN_ISSUE_MIN_GAP_MS) {
      throw new KisError('token_issue_throttled', 'token issue attempted too soon');
    }
    await deps.kv.set('kis_token_issue_at', now().toISOString(), null);
    const res = await f(`${KIS_ORIGIN}${KIS_PATHS.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: deps.appKey, appsecret: deps.appSecret }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new KisError(String(body.error_code ?? res.status), 'token issue failed');
    }
    const expires = tokenExpiry(body, now());
    await deps.kv.set('kis_token', body.access_token, expires);
    return body.access_token;
  }

  async function token(force = false): Promise<string> {
    if (!force) {
      const row = await deps.kv.get('kis_token');
      if (row?.expires_at && Date.parse(row.expires_at) - now().getTime() > TOKEN_REUSE_MARGIN_MS) return row.value;
    }
    return issueToken();
  }

  async function get(path: string, trId: string, params: Record<string, string>, retried = false): Promise<Record<string, unknown>> {
    const t = await token(retried);
    const url = `${KIS_ORIGIN}${path}?${new URLSearchParams(params)}`;
    const res = await f(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${t}`,
        appkey: deps.appKey,
        appsecret: deps.appSecret,
        tr_id: trId,
        custtype: 'P',
      },
    });
    const body = await res.json().catch(() => ({}));
    // 토큰 만료로 보이는 응답이면 한 번만 새 토큰으로 다시 시도 (만료 오류 코드 값은 공식 문서로 확인 못 함 → HTTP 401·403 기준)
    if ((res.status === 401 || res.status === 403) && !retried) return get(path, trId, params, true);
    if (!res.ok || body.rt_cd !== '0') {
      throw new KisError(String(body.msg_cd ?? res.status), String(body.msg1 ?? 'kis error'));
    }
    return body;
  }

  return {
    token,
    async price(symbol: string) {
      const b = await get(KIS_PATHS.price, KIS_TR.price, { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol });
      return parsePrice(b.output as Record<string, string>);
    },
    // hhmmss 이전 30개 1분봉(당일만)
    async minuteBars(symbol: string, hhmmss: string) {
      const b = await get(KIS_PATHS.minute, KIS_TR.minute, {
        FID_ETC_CLS_CODE: '',
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: symbol,
        FID_INPUT_HOUR_1: hhmmss,
        FID_PW_DATA_INCU_YN: 'N',
      });
      return parseMinuteBars(b.output2 as Record<string, string>[]);
    },
    async dailyBars(symbol: string, from: string, to: string) {
      const b = await get(KIS_PATHS.daily, KIS_TR.daily, {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: from,
        FID_INPUT_DATE_2: to,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '0',
      });
      return parseDailyBars(b.output2 as Record<string, string>[]);
    },
    async holidays(baseDate: string) {
      const b = await get(KIS_PATHS.holiday, KIS_TR.holiday, { BASS_DT: baseDate, CTX_AREA_NK: '', CTX_AREA_FK: '' });
      return parseHolidays(b.output as Record<string, string>[]);
    },
    async stockInfo(symbol: string) {
      const b = await get(KIS_PATHS.stockInfo, KIS_TR.stockInfo, { PRDT_TYPE_CD: '300', PDNO: symbol });
      return parseStockInfo(symbol, b.output as Record<string, string>);
    },
  };
}

// ───────── 응답 해석(순수 함수) ─────────

export function tokenExpiry(body: Record<string, unknown>, now: Date): Date {
  const sec = Number(body.expires_in);
  if (Number.isFinite(sec) && sec > 0) return new Date(now.getTime() + sec * 1000);
  // "YYYY-MM-DD HH:MM:SS" — 시간대 표기가 없어 한국 시간으로 해석(추정)
  const s = String(body.access_token_token_expired ?? '');
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s);
  if (m) return new Date(`${m[1]}T${m[2]}+09:00`);
  return new Date(now.getTime() + 6 * 3600 * 1000); // 모르면 짧게 잡는다
}

const num = (s: unknown): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// 'YYYYMMDD' + 'HHMMSS'(한국 시간) → ISO(UTC)
export function kstToIso(date: string, time = '000000'): string {
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const t = `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  return new Date(`${d}T${t}+09:00`).toISOString();
}

export function parsePrice(o: Record<string, string>) {
  const price = num(o?.stck_prpr);
  if (price === null) throw new KisError('parse', 'no price');
  return {
    price,
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    volume: num(o.acml_vol),
    base_price: num(o.stck_sdpr),
    upper_limit: num(o.stck_mxpr),
    lower_limit: num(o.stck_llam),
  };
}

export type Bar = { t: string; o: number; h: number; l: number; c: number; v: number | null };

export function parseMinuteBars(rows: Record<string, string>[]): Bar[] {
  return (rows ?? [])
    .filter((r) => r && /^\d{8}$/.test(r.stck_bsop_date) && /^\d{6}$/.test(r.stck_cntg_hour) && num(r.stck_prpr) !== null)
    .map((r) => ({
      t: kstToIso(r.stck_bsop_date, r.stck_cntg_hour),
      o: num(r.stck_oprc)!,
      h: num(r.stck_hgpr)!,
      l: num(r.stck_lwpr)!,
      c: num(r.stck_prpr)!,
      v: num(r.cntg_vol),
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

// 일봉 시각 = 그 거래일 00:00 한국 시간
export function parseDailyBars(rows: Record<string, string>[]): Bar[] {
  return (rows ?? [])
    .filter((r) => r && /^\d{8}$/.test(r.stck_bsop_date) && num(r.stck_clpr) !== null)
    .map((r) => ({
      t: kstToIso(r.stck_bsop_date),
      o: num(r.stck_oprc)!,
      h: num(r.stck_hgpr)!,
      l: num(r.stck_lwpr)!,
      c: num(r.stck_clpr)!,
      v: num(r.acml_vol),
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

export function parseHolidays(rows: Record<string, string>[]) {
  return (rows ?? [])
    .filter((r) => r && /^\d{8}$/.test(r.bass_dt) && (r.opnd_yn === 'Y' || r.opnd_yn === 'N'))
    .map((r) => ({
      trade_date: `${r.bass_dt.slice(0, 4)}-${r.bass_dt.slice(4, 6)}-${r.bass_dt.slice(6, 8)}`,
      is_open: r.opnd_yn === 'Y',
    }));
}

// 시장 구분: 상장일자 필드로 판단(유가증권/코스닥 상장일자 중 값이 있는 쪽 — 추정, 공식 코드표 확인 못 함).
// 주권만(v0.1): 증권그룹 'ST' 만 허용(추정).
export function parseStockInfo(symbol: string, o: Record<string, string>) {
  if (!o) return null;
  const name = (o.prdt_abrv_name || o.prdt_name || '').trim();
  if (!name) return null;
  const kospi = /^\d{8}$/.test(o.scts_mket_lstg_dt ?? '');
  const kosdaq = /^\d{8}$/.test(o.kosdaq_mket_lstg_dt ?? '');
  const delisted = /^\d{8}$/.test(o.lstg_abol_dt ?? '');
  const isStock = (o.scty_grp_id_cd ?? '') === 'ST';
  if (!isStock || delisted || kospi === kosdaq) return null;
  return { market: 'KR', symbol, name, exchange: kospi ? 'KOSPI' : 'KOSDAQ', currency: 'KRW' } as const;
}
