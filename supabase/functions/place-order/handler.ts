// place-order / cancel-order: 입력 모양만 확인하고 DB 함수(sp.place_order / sp.cancel_order)를 사용자 JWT 로 부른다.
// 가격·수수료·세금·체결 판단은 전부 DB 함수가 한다(서버가 유일한 정답, 브라우저 미리보기도 dry_run 으로 같은 함수).
import { bearerToken, type Caller } from '../_shared/auth.ts';
import { KR_SYMBOL } from '../_shared/jobs.ts';
import { US_SYMBOL } from '../_shared/providers/alpaca.ts';

export type OrderInput = {
  market: 'KR' | 'US';
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  qty: number;
  limit: number | string | null;
  dry_run: boolean;
};

export type RpcResult = { data: unknown } | { errorCode: string; message: string };

export type OrderDeps = {
  allowedOrigins: string[];
  getCaller: (jwt: string) => Promise<Caller | 'invalid' | null>;
  placeOrder: (jwt: string, o: OrderInput) => Promise<RpcResult>;
  cancelOrder: (jwt: string, orderId: number) => Promise<RpcResult>;
};

// DB 가 돌려주는 오류 메시지 중 화면에 그대로 보여도 되는 것(나머지는 server_error)
export const KNOWN_ERRORS = new Set([
  'invalid_side', 'invalid_type', 'invalid_qty', 'invalid_limit', 'unknown_instrument', 'tick_unknown', 'tick_mismatch',
  'price_limit', 'krw_negative', 'quote_stale', 'no_quote', 'insufficient_funds', 'insufficient_qty',
  'not_registered', 'forbidden', 'not_found', 'not_cancellable',
]);

function cors(req: Request, origins: string[]): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (origins.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export function parseOrder(b: Record<string, unknown>): OrderInput | string {
  const market = b.market;
  if (market !== 'KR' && market !== 'US') return 'invalid_market';
  const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : '';
  if (!(market === 'KR' ? KR_SYMBOL : US_SYMBOL).test(symbol)) return 'invalid_symbol';
  if (b.side !== 'buy' && b.side !== 'sell') return 'invalid_side';
  if (b.type !== 'market' && b.type !== 'limit') return 'invalid_type';
  const qty = b.qty;
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 1000000) return 'invalid_qty';
  let limit: number | string | null = null;
  if (b.type === 'limit') {
    const l = b.limit;
    const s = typeof l === 'number' ? String(l) : typeof l === 'string' ? l.trim() : '';
    if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) <= 0) return 'invalid_limit';
    limit = s;
  } else if (b.limit !== undefined && b.limit !== null) {
    return 'invalid_limit';
  }
  return { market, symbol, side: b.side, type: b.type, qty, limit, dry_run: b.dry_run === true };
}

function makeHandler(deps: OrderDeps, run: (jwt: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>) {
  return async (req: Request): Promise<Response> => {
    const h = cors(req, deps.allowedOrigins);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    const jwt = bearerToken(req);
    if (!jwt) return json(401, { ok: false, error: 'missing_token' });
    let body: Record<string, unknown>;
    try {
      const b = await req.json();
      if (!b || typeof b !== 'object' || Array.isArray(b)) return json(400, { ok: false, error: 'invalid_body' });
      body = b as Record<string, unknown>;
    } catch {
      return json(400, { ok: false, error: 'invalid_body' });
    }
    const caller = await deps.getCaller(jwt);
    if (caller === 'invalid') return json(401, { ok: false, error: 'invalid_token' });
    if (caller === null) return json(403, { ok: false, error: 'not_registered' });
    const r = await run(jwt, body);
    return json(r.status, r.body);
  };
}

function fromRpc(r: RpcResult): { status: number; body: unknown } {
  if ('data' in r) return { status: 200, body: r.data };
  const code = KNOWN_ERRORS.has(r.message) ? r.message : 'server_error';
  if (r.errorCode === '42501') return { status: 403, body: { ok: false, error: code === 'server_error' ? 'forbidden' : code } };
  if (r.errorCode === '22023') return { status: 400, body: { ok: false, error: code } };
  return { status: 500, body: { ok: false, error: 'server_error' } };
}

export function createPlaceHandler(deps: OrderDeps) {
  return makeHandler(deps, async (jwt, body) => {
    const o = parseOrder(body);
    if (typeof o === 'string') return { status: 400, body: { ok: false, error: o } };
    return fromRpc(await deps.placeOrder(jwt, o));
  });
}

export function createCancelHandler(deps: OrderDeps) {
  return makeHandler(deps, async (jwt, body) => {
    const id = body.order_id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return { status: 400, body: { ok: false, error: 'invalid_order_id' } };
    return fromRpc(await deps.cancelOrder(jwt, id));
  });
}
