// 사용자 JWT 로 부르는 DB 클라이언트(publishable 키 + 호출자 JWT). RLS·security definer 함수가 권한을 판단한다.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { getCaller, type UserScopedDb } from './auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const PUBLISHABLE = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')['default'] ?? '';

export const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://sigyemin.github.io')
  .split(',').map((s: string) => s.trim()).filter(Boolean);

export function userDb(jwt: string) {
  return createClient(SUPABASE_URL, PUBLISHABLE, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const callerOf = (jwt: string) => getCaller(userDb(jwt) as unknown as UserScopedDb, jwt);

// sp 스키마 rpc 를 사용자 JWT 로. 오류는 { errorCode, message }
export async function userRpc(jwt: string, fn: string, args: Record<string, unknown>) {
  const { data, error } = await userDb(jwt).schema('sp').rpc(fn, args);
  if (error) {
    const e = error as { code?: string; message?: string };
    return { errorCode: String(e.code ?? ''), message: String(e.message ?? '') };
  }
  return { data };
}
