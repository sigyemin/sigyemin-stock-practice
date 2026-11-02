// fund-grant: 추가 자금 지급 요청 처리(순수 로직). Deno·Node 시험 양쪽에서 쓰도록 의존성은 주입한다.
// 입력  : POST { to: 참가자 id, currency: 'KRW'|'USD', amount }  + Authorization: Bearer <사용자 JWT>
// 규칙  : 호출자는 허용 계정 / to 는 본인, 또는 봇이면서 호출자가 can_fund_bot
//         amount 양수, KRW 정수, USD 소수 2자리, 1회 상한(app_settings)
// 처리  : sp.request_fund(사용자 JWT 로 호출) — DB 가 같은 규칙을 한 번 더 검사(이중 방어)
import { isValidAmount } from '../_shared/money.ts';
import { bearerToken, type Caller } from '../_shared/auth.ts';

export type Currency = 'KRW' | 'USD';

export type FundDeps = {
  getCaller: (jwt: string) => Promise<Caller | 'invalid' | null>;
  getParticipantKind: (jwt: string, id: number) => Promise<'human' | 'bot' | null>;
  getLimits: (jwt: string) => Promise<Record<Currency, number | null>>;
  requestFund: (
    jwt: string,
    to: number,
    currency: Currency,
    amount: number | string,
  ) => Promise<{ balance: number } | { errorCode: string }>;
  allowedOrigins: string[];
};

function corsHeaders(req: Request, origins: string[]): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (origins.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(status: number, body: unknown, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extra, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function createHandler(deps: FundDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req, deps.allowedOrigins);
    const fail = (status: number, error: string) => json(status, { ok: false, error }, cors);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return fail(405, 'method_not_allowed');

    const jwt = bearerToken(req);
    if (!jwt) return fail(401, 'missing_token');

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'invalid_body');
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, 'invalid_body');
    }

    const caller = await deps.getCaller(jwt);
    if (caller === 'invalid') return fail(401, 'invalid_token');
    if (caller === null) return fail(403, 'not_registered');

    const to = body.to;
    const currency = body.currency;
    const amount = body.amount;
    if (typeof to !== 'number' || !Number.isInteger(to)) return fail(400, 'invalid_to');
    if (currency !== 'KRW' && currency !== 'USD') return fail(400, 'invalid_currency');
    if (!isValidAmount(currency, amount)) return fail(400, 'invalid_amount');

    const kind = await deps.getParticipantKind(jwt, to);
    if (kind === null) return fail(400, 'invalid_to');
    const allowed = to === caller.participantId || (kind === 'bot' && caller.canFundBot);
    if (!allowed) return fail(403, 'forbidden_target');

    const limits = await deps.getLimits(jwt);
    const max = limits[currency];
    if (max === null || max === undefined) return fail(500, 'limit_not_configured');
    if (Number(amount) > max) return fail(400, 'over_limit');

    const res = await deps.requestFund(jwt, to, currency, amount as number | string);
    if ('errorCode' in res) {
      if (res.errorCode === '42501') return fail(403, 'forbidden');
      if (res.errorCode === '22023') return fail(400, 'rejected');
      return fail(500, 'server_error');
    }
    return json(200, { ok: true, participant_id: to, currency, balance: res.balance }, cors);
  };
}
