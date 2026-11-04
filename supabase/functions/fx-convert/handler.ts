// fx-convert / tax-pay: 입력 모양만 확인하고 DB 함수(sp.fx_convert / sp.cgt_pay)를 사용자 JWT 로 부른다.
// 환율·스프레드·우대율·세액 계산과 본인 확인은 전부 DB 함수가 한다(미리보기도 dry_run 으로 같은 함수).
import { fromRpc, makeHandler, type RpcResult, type UserDeps } from '../place-order/handler.ts';

export type FxInput = { direction: 'KRW_TO_USD' | 'USD_TO_KRW'; amount: string; dry_run: boolean };

export function parseFx(b: Record<string, unknown>): FxInput | string {
  const direction = b.direction;
  if (direction !== 'KRW_TO_USD' && direction !== 'USD_TO_KRW') return 'invalid_direction';
  const a = b.amount;
  const s = typeof a === 'number' ? String(a) : typeof a === 'string' ? a.trim() : '';
  // 원화는 원 단위 정수, 달러는 센트(소수 2자리)까지. 최종 확인은 DB
  const re = direction === 'KRW_TO_USD' ? /^\d{1,12}$/ : /^\d{1,10}(\.\d{1,2})?$/;
  if (!re.test(s) || Number(s) <= 0) return 'invalid_amount';
  return { direction, amount: s, dry_run: b.dry_run === true };
}

export function createFxHandler(deps: UserDeps & { fxConvert: (jwt: string, i: FxInput) => Promise<RpcResult> }) {
  return makeHandler(deps, async (jwt, body) => {
    const i = parseFx(body);
    if (typeof i === 'string') return { status: 400, body: { ok: false, error: i } };
    return fromRpc(await deps.fxConvert(jwt, i));
  });
}

export function createTaxPayHandler(deps: UserDeps & { cgtPay: (jwt: string, year: number) => Promise<RpcResult> }) {
  return makeHandler(deps, async (jwt, body) => {
    const y = body.year;
    if (typeof y !== 'number' || !Number.isInteger(y) || y < 2026 || y > 2100) return { status: 400, body: { ok: false, error: 'invalid_year' } };
    return fromRpc(await deps.cgtPay(jwt, y));
  });
}
