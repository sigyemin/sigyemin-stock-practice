// Edge Function: fund-grant (Deno). 실제 로직은 handler.ts.
// 서버 비밀 키를 쓰지 않는다: publishable 키 + 호출자 JWT 로 DB 를 부르고, 권한은 RLS·sp.request_fund 가 판단.
// config.toml 에서 verify_jwt = false(새 API 키 방식) → JWT 확인은 auth.getUser 로 코드에서 한다.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { getCaller, type UserScopedDb } from '../_shared/auth.ts';
import { createHandler, type Currency } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
// TODO(L4): 배포 직후 SUPABASE_PUBLISHABLE_KEYS 가 주입되는지 스모크 테스트로 확인. 없으면 빈 키 → 호출 실패(fail-closed).
const PUBLISHABLE = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')['default'] ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://sigyemin.github.io')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

function userDb(jwt: string) {
  return createClient(SUPABASE_URL, PUBLISHABLE, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const handler = createHandler({
  allowedOrigins: ALLOWED_ORIGINS,

  getCaller: (jwt) => getCaller(userDb(jwt) as unknown as UserScopedDb, jwt),

  async getParticipantKind(jwt, id) {
    const { data, error } = await userDb(jwt).schema('sp').from('participants')
      .select('kind').eq('id', id).maybeSingle();
    if (error || !data) return null;
    return data.kind === 'bot' ? 'bot' : 'human';
  },

  async getLimits(jwt) {
    const { data } = await userDb(jwt).schema('sp').from('app_settings')
      .select('key, value').in('key', ['fund_max_krw', 'fund_max_usd']);
    const get = (k: string) => {
      const row = (data ?? []).find((r: { key: string }) => r.key === k);
      return row ? Number(row.value) : null;
    };
    return { KRW: get('fund_max_krw'), USD: get('fund_max_usd') } as Record<Currency, number | null>;
  },

  async requestFund(jwt, to, currency, amount) {
    const { data, error } = await userDb(jwt).schema('sp').rpc('request_fund', {
      p_to: to,
      p_currency: currency,
      p_amount: amount,
    });
    if (error) return { errorCode: String((error as { code?: string }).code ?? '') };
    const row = Array.isArray(data) ? data[0] : data;
    return { balance: Number(row?.balance) };
  },
});

Deno.serve(handler);
