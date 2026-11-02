import { el } from '../dom.js';
import { signInWithGoogle } from '../auth.js';

// notice: 'denied'(미등록 계정) | 'error' | 'unconfigured' | null
export function loginScreen(notice) {
  const msg = {
    denied: '등록되지 않은 계정입니다. 로그아웃했습니다.',
    error: '확인 중 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.',
    unconfigured: '아직 서버 설정 전입니다(config.js).',
  }[notice];

  const btn = el('button', {
    text: '구글로 로그인',
    className: 'primary',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        btn.disabled = true;
        try {
          await signInWithGoogle();
        } catch {
          btn.disabled = false;
          status.textContent = '로그인을 시작하지 못했습니다.';
        }
      },
    },
  });
  if (notice === 'unconfigured') btn.disabled = true;
  const status = el('p', { className: 'notice', text: msg ?? '', attrs: { role: 'status' } });

  return el('section', { className: 'card login' }, [
    el('h1', { text: '주식 연습' }),
    el('p', { text: '가상 돈으로 하는 매매 연습입니다. 등록된 계정만 쓸 수 있습니다.' }),
    btn,
    status,
  ]);
}
