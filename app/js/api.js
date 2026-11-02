// Supabase 클라이언트와 서버 호출. supabase-js 는 index.html 에서 vendor UMD(전역 supabase)로 읽는다.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../config.js';

export function isConfigured() {
  return /^https:\/\//.test(SUPABASE_URL) && SUPABASE_PUBLISHABLE_KEY !== 'TODO' && SUPABASE_PUBLISHABLE_KEY !== '';
}

let client = null;
export function db() {
  if (!client) {
    client = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      db: { schema: 'sp' },
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}

export async function loadOverview() {
  const c = db();
  const [p, a] = await Promise.all([
    c.from('participants').select('id, alias, kind').order('id'),
    c.from('accounts').select('participant_id, currency, balance'),
  ]);
  if (p.error) throw p.error;
  if (a.error) throw a.error;
  return { participants: p.data, accounts: a.data };
}

// 추가 자금: Edge Function fund-grant 호출(사용자 JWT 는 supabase-js 가 붙인다)
export async function requestFund(to, currency, amount) {
  const { data, error } = await db().functions.invoke('fund-grant', {
    body: { to, currency, amount },
  });
  if (error) {
    let code = 'server_error';
    try {
      const body = await error.context?.json?.();
      if (body?.error) code = body.error;
    } catch {
      /* 응답 본문 없음 */
    }
    return { ok: false, error: code };
  }
  return data;
}
