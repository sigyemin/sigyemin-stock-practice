// 한국수출입은행 현재환율(매매기준율 deal_bas_r).
// 요청 주소: https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=&searchdate=YYYYMMDD&data=AP01
//   (2026-11-04 이 주소에 잘못된 키로 요청 → 200 + [{"result":3, ... 모든 값 null}] 응답 확인. 정상 응답 형식은 키가 없어 직접 확인 못 함)
// 영업일 11시 전후 갱신, 그 전·휴일은 값 없음 → null 을 돌려주고, 쓰는 쪽이 직전 고시값을 쓴다.
import { guardedFetch, type AllowRule, type FetchLike } from '../http.ts';

export const EXIM_ORIGIN = 'https://oapi.koreaexim.go.kr';
export const EXIM_PATH = '/site/program/financial/exchangeJSON';
export const EXIM_ALLOW: AllowRule[] = [{ method: 'GET', origin: EXIM_ORIGIN, path: EXIM_PATH }];

export class EximError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EximError';
  }
}

export function createExim(deps: { authKey: string; fetch: FetchLike }) {
  const f = guardedFetch(EXIM_ALLOW, deps.fetch);
  return {
    async usdkrw(yyyymmdd: string): Promise<number | null> {
      const q = new URLSearchParams({ authkey: deps.authKey, searchdate: yyyymmdd, data: 'AP01' });
      const res = await f(`${EXIM_ORIGIN}${EXIM_PATH}?${q}`, { method: 'GET' });
      if (!res.ok) throw new EximError(`http ${res.status}`);
      return parseUsdKrw(await res.json());
    },
  };
}

// 배열에서 USD 의 매매기준율. 값이 없으면 null(고시 전·휴일). result 가 1 이 아닌 행이 있으면 오류.
export function parseUsdKrw(rows: unknown): number | null {
  if (!Array.isArray(rows)) throw new EximError('unexpected body');
  if (rows.length === 0) return null;
  const bad = rows.find((r) => r && typeof r === 'object' && 'result' in r && (r as { result: unknown }).result !== 1);
  if (bad) throw new EximError(`result ${(bad as { result: unknown }).result}`);
  const usd = rows.find((r) => r && (r as { cur_unit?: unknown }).cur_unit === 'USD') as { deal_bas_r?: unknown } | undefined;
  if (!usd || usd.deal_bas_r === null || usd.deal_bas_r === undefined) return null;
  const v = Number(String(usd.deal_bas_r).replace(/,/g, ''));
  if (!Number.isFinite(v) || v <= 0) throw new EximError('bad rate');
  return v;
}
