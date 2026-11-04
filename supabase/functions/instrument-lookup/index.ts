// Edge Function: instrument-lookup (Deno). 로직은 handler.ts.
// 호출자 확인은 사용자 JWT(publishable 키 + JWT 로 sp.allowed_users 본인 행), 종목·일봉 저장은 서버 클라이언트(secret 키).
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { getCaller, type UserScopedDb } from '../_shared/auth.ts';
import { alpacaFromEnv, jobDb, kisFromEnv, serviceDb, SupabaseKv } from '../_shared/server.ts';
import { backfillDaily } from '../_shared/jobs.ts';
import { createHandler, ProviderNotConfigured, type Instrument } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const PUBLISHABLE = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')['default'] ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://sigyemin.github.io')
  .split(',').map((s: string) => s.trim()).filter(Boolean);

const userDb = (jwt: string) =>
  createClient(SUPABASE_URL, PUBLISHABLE, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

const db = serviceDb();
const kv = new SupabaseKv(db);
const jdb = jobDb(db);

Deno.serve(createHandler({
  allowedOrigins: ALLOWED_ORIGINS,
  getCaller: (jwt) => getCaller(userDb(jwt) as unknown as UserScopedDb, jwt),

  async findInstrument(market, symbol) {
    const { data, error } = await db.from('instruments').select('market, symbol, name, exchange, currency')
      .eq('market', market).eq('symbol', symbol).maybeSingle();
    if (error) throw new Error('db_instruments');
    return data as Instrument | null;
  },

  async lookup(market, symbol) {
    if (market === 'KR') {
      const kis = kisFromEnv(kv);
      if (!kis) throw new ProviderNotConfigured();
      return (await kis.stockInfo(symbol)) as Instrument | null;
    }
    const alpaca = alpacaFromEnv();
    if (!alpaca) throw new ProviderNotConfigured();
    return (await alpaca.asset(symbol)) as Instrument | null;
  },

  async saveInstrument(i) {
    const { error } = await db.from('instruments').upsert({ ...i, active: true, updated_at: new Date().toISOString() });
    if (error) throw new Error('db_instrument_write');
  },

  async backfill(market, symbol) {
    const s = await jdb.settings();
    const days = Math.min(Math.max(Number(s.backfill_days_1d) || 365, 30), 730);
    return backfillDaily({ market, symbol, days, kis: kisFromEnv(kv), alpaca: alpacaFromEnv(), now: () => new Date() });
  },

  saveCandles: (rows) => jdb.saveCandles(rows),
}));
