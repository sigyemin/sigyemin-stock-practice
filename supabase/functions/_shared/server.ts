// Deno 쪽 연결부: 서버 DB 클라이언트(secret 키, 기본 주입값), 공급자 생성(비밀값), cron 호출 확인.
// 키 이름: KIS_APP_KEY, KIS_APP_SECRET, ALPACA_KEY_ID, ALPACA_SECRET_KEY, KOREAEXIM_AUTHKEY (Edge Function 비밀값)
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { verifyCronToken, type KvRow, type KvStore } from './kv.ts';
import type { JobDb, JobResult } from './jobs.ts';
import { createKis } from './providers/kis.ts';
import { createAlpaca } from './providers/alpaca.ts';
import { createExim } from './providers/koreaexim.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');

export function serviceDb() {
  const key = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}')['default'] ?? '';
  return createClient(SUPABASE_URL, key, {
    db: { schema: 'sp' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
type Db = ReturnType<typeof serviceDb>;

export class SupabaseKv implements KvStore {
  constructor(private db: Db) {}
  async get(key: string): Promise<KvRow | null> {
    const { data, error } = await this.db.from('server_kv').select('value, expires_at').eq('key', key).maybeSingle();
    if (error) throw new Error('kv_read');
    return data as KvRow | null;
  }
  async set(key: string, value: string, expiresAt: Date | null) {
    const { error } = await this.db.from('server_kv')
      .upsert({ key, value, expires_at: expiresAt?.toISOString() ?? null, updated_at: new Date().toISOString() });
    if (error) throw new Error('kv_write');
  }
  async claim(key: string, minGapMs: number): Promise<boolean> {
    const { data, error } = await this.db.rpc('kv_claim', { p_key: key, p_min_gap_ms: Math.round(minGapMs) });
    if (error) throw new Error('kv_claim');
    return data === true;
  }
}

export function jobDb(db: Db): JobDb {
  const check = (error: unknown, what: string) => {
    if (error) throw new Error(`db_${what}`);
  };
  return {
    async settings() {
      const { data, error } = await db.from('app_settings').select('key, value');
      check(error, 'settings');
      return Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    },
    async calendar(market, date) {
      const { data, error } = await db.from('market_calendar').select('trade_date, is_open, open_at, close_at')
        .eq('market', market).eq('trade_date', date).maybeSingle();
      check(error, 'calendar');
      return data;
    },
    async watchSymbols(market, limit) {
      // 관심 종목(세 참가자 합집합). 보유 종목은 M3 에서 positions 를 더한다.
      const { data, error } = await db.from('watchlist').select('symbol, added_at').eq('market', market)
        .order('added_at', { ascending: true }).limit(500);
      check(error, 'watchlist');
      return [...new Set((data ?? []).map((r: { symbol: string }) => r.symbol))].slice(0, limit);
    },
    async saveQuotes(rows) {
      const { error } = await db.from('quotes').upsert(rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() })));
      check(error, 'quotes');
    },
    async saveCandles(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('candles').upsert(rows.slice(i, i + 500));
        check(error, 'candles');
      }
    },
    async saveFx(date, usdkrw, source) {
      const { error } = await db.from('fx_rates').upsert({ rate_date: date, usdkrw, source, fetched_at: new Date().toISOString() });
      check(error, 'fx');
    },
    async processOrders(market) {
      const { data, error } = await db.rpc('process_orders', { p_market: market });
      check(error, 'process_orders');
      return Number(data) || 0;
    },
    async expireOrders(market) {
      const { data, error } = await db.rpc('expire_orders', { p_market: market });
      check(error, 'expire_orders');
      return Number(data) || 0;
    },
    async saveCalendar(rows) {
      if (rows.length === 0) return;
      const { error } = await db.from('market_calendar').upsert(rows);
      check(error, 'calendar_write');
    },
  };
}

export function kisFromEnv(kv: KvStore) {
  const appKey = env('KIS_APP_KEY');
  const appSecret = env('KIS_APP_SECRET');
  return appKey && appSecret ? createKis({ appKey, appSecret, kv, transport: fetch }) : null;
}

export function alpacaFromEnv() {
  const keyId = env('ALPACA_KEY_ID');
  const secretKey = env('ALPACA_SECRET_KEY');
  return keyId && secretKey ? createAlpaca({ keyId, secretKey, transport: fetch }) : null;
}

export function eximFromEnv() {
  const authKey = env('KOREAEXIM_AUTHKEY');
  return authKey ? createExim({ authKey, transport: fetch }) : null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

// cron 전용 함수: POST + x-cron-token(= sp.server_kv 'cron_token') 이 맞을 때만 실행
export function cronHandler(run: (db: Db, kv: KvStore) => Promise<JobResult>) {
  return async (req: Request) => {
    if (req.method !== 'POST') return json(405, { status: 'error', reason: 'method_not_allowed' });
    const db = serviceDb();
    const kv = new SupabaseKv(db);
    if (!(await verifyCronToken(kv, req))) return json(401, { status: 'error', reason: 'unauthorized' });
    try {
      const result = await run(db, kv);
      return json(result.status === 'error' ? 500 : 200, result);
    } catch (e) {
      return json(500, { status: 'error', reason: (e as Error)?.name ?? 'error' });
    }
  };
}
