// 구글 로그인 + 허용 계정 확인. 허용 목록(sp.allowed_users)에 없으면 안내 후 강제 로그아웃.
import { db } from './api.js';

export async function signInWithGoogle() {
  const redirectTo = location.origin + location.pathname;
  const { error } = await db().auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw error;
}

export async function signOut() {
  await db().auth.signOut();
}

export async function currentSession() {
  const { data } = await db().auth.getSession();
  return data.session;
}

// 반환: { status: 'none' } | { status: 'denied' } | { status: 'error' } | { status: 'ok', me: { participantId, canFundBot } }
export async function checkMember() {
  const session = await currentSession();
  if (!session) return { status: 'none' };
  const { data, error } = await db()
    .from('allowed_users')
    .select('participant_id, can_fund_bot')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();
  if (error) return { status: 'error' }; // 네트워크 등: 로그아웃하지 않고 다시 시도하게
  if (!data) {
    await signOut();
    return { status: 'denied' };
  }
  return { status: 'ok', me: { participantId: data.participant_id, canFundBot: data.can_fund_bot === true } };
}
