// instrument-lookup: 허용 계정이 종목코드(KR 6자리)·티커(US)로 종목을 추가할 때 호출.
// 이미 있으면 그대로 돌려주고, 없으면 공급자에서 종목 정보를 받아 저장 + 일봉 기록을 받아 둔다.
// 입력: POST { market: 'KR'|'US', symbol }  + Authorization: Bearer <사용자 JWT>
import { bearerToken, type Caller } from '../_shared/auth.ts';
import { KR_SYMBOL, type CandleRow } from '../_shared/jobs.ts';
import { US_SYMBOL } from '../_shared/providers/alpaca.ts';

export type Instrument = { market: 'KR' | 'US'; symbol: string; name: string; exchange: string; currency: 'KRW' | 'USD' };

export class ProviderNotConfigured extends Error {
  constructor() {
    super('provider_not_configured');
    this.name = 'ProviderNotConfigured';
  }
}

export type LookupDeps = {
  allowedOrigins: string[];
  getCaller: (jwt: string) => Promise<Caller | 'invalid' | null>;
  findInstrument: (market: 'KR' | 'US', symbol: string) => Promise<Instrument | null>;
  lookup: (market: 'KR' | 'US', symbol: string) => Promise<Instrument | null>; // ProviderNotConfigured 를 던질 수 있음
  saveInstrument: (i: Instrument) => Promise<void>;
  backfill: (market: 'KR' | 'US', symbol: string) => Promise<CandleRow[]>;
  saveCandles: (rows: CandleRow[]) => Promise<void>;
};

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

export function createHandler(deps: LookupDeps) {
  return async (req: Request): Promise<Response> => {
    const h = cors(req, deps.allowedOrigins);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } });
    const fail = (status: number, error: string) => json(status, { ok: false, error });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'POST') return fail(405, 'method_not_allowed');
    const jwt = bearerToken(req);
    if (!jwt) return fail(401, 'missing_token');

    let body: Record<string, unknown>;
    try {
      const b = await req.json();
      if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'invalid_body');
      body = b as Record<string, unknown>;
    } catch {
      return fail(400, 'invalid_body');
    }

    const caller = await deps.getCaller(jwt);
    if (caller === 'invalid') return fail(401, 'invalid_token');
    if (caller === null) return fail(403, 'not_registered');

    const market = body.market;
    if (market !== 'KR' && market !== 'US') return fail(400, 'invalid_market');
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (!(market === 'KR' ? KR_SYMBOL : US_SYMBOL).test(symbol)) return fail(400, 'invalid_symbol');

    const existing = await deps.findInstrument(market, symbol);
    if (existing) return json(200, { ok: true, instrument: existing, created: false });

    let info: Instrument | null;
    try {
      info = await deps.lookup(market, symbol);
    } catch (e) {
      if (e instanceof ProviderNotConfigured) return fail(503, 'provider_not_configured');
      return fail(502, 'provider_error');
    }
    if (!info) return fail(404, 'not_found');
    await deps.saveInstrument(info);
    let candles = 0;
    try {
      const rows = await deps.backfill(market, symbol);
      if (rows.length) await deps.saveCandles(rows);
      candles = rows.length;
    } catch {
      // 종목은 저장됐다. 일봉은 다음 기회에(실패해도 종목 추가는 성공으로 본다)
    }
    return json(200, { ok: true, instrument: info, created: true, candles });
  };
}
