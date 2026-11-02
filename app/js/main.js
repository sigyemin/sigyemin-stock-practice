// 시작·라우팅. 화면: #/home(기본), #/funds
import { el, mount } from './dom.js';
import { isConfigured, db, loadOverview } from './api.js';
import { checkMember, signOut } from './auth.js';
import { loginScreen } from './screens/login.js';
import { homeScreen } from './screens/home.js';
import { fundsScreen } from './screens/funds.js';

const root = document.getElementById('app');
let me = null;
let pendingNotice = null; // 강제 로그아웃 뒤 SIGNED_OUT 으로 다시 그려져도 안내가 남게

function nav() {
  const link = (hash, text) =>
    el('a', { text, attrs: { href: hash, 'aria-current': location.hash === hash ? 'page' : 'false' } });
  return el('nav', {}, [
    link('#/home', '홈'),
    link('#/funds', '추가 자금'),
    el('button', { text: '로그아웃', attrs: { type: 'button' }, on: { click: () => signOut() } }),
  ]);
}

async function render() {
  if (!isConfigured()) return mount(root, loginScreen('unconfigured'));
  const r = await checkMember();
  if (r.status !== 'ok') {
    me = null;
    if (r.status !== 'none') pendingNotice = r.status;
    const notice = pendingNotice;
    if (r.status === 'none') pendingNotice = null;
    return mount(root, loginScreen(notice));
  }
  pendingNotice = null;
  me = r.me;
  let data;
  try {
    data = await loadOverview();
  } catch {
    return mount(root, nav(), el('p', { className: 'notice', text: '잔고를 불러오지 못했습니다.' }));
  }
  const screen = location.hash === '#/funds' ? fundsScreen(data, me, () => {}) : homeScreen(data, me);
  mount(root, nav(), screen);
}

window.addEventListener('hashchange', render);
if (isConfigured()) {
  db().auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(render, 0);
  });
}
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
