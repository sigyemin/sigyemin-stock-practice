// 요청 JWT → 호출자(participant_id). 미등록이면 null.
// 사용자 JWT 를 그대로 붙인 클라이언트로 sp.allowed_users 를 읽는다(RLS: 본인 행만 보임).
// 서버 비밀 키는 쓰지 않는다 → 권한 판단은 DB(RLS·sp.request_fund)가 최종 기준.

export type Caller = { participantId: number; canFundBot: boolean };

// supabase-js 클라이언트 중 이 모듈이 쓰는 부분만(시험에서 가짜로 바꿔 끼우기 쉽게)
export type UserScopedDb = {
  auth: {
    getUser: (jwt: string) => Promise<{ data: { user: { id: string } | null }; error: unknown }>;
  };
  schema: (name: string) => {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
        };
      };
    };
  };
};

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function getCaller(db: UserScopedDb, jwt: string): Promise<Caller | 'invalid' | null> {
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return 'invalid';
  const res = await db
    .schema('sp')
    .from('allowed_users')
    .select('participant_id, can_fund_bot')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return {
    participantId: Number(res.data.participant_id),
    canFundBot: res.data.can_fund_bot === true,
  };
}
