// 시작·라우팅. 화면: #/home(기본), #/funds
import { el, mount } from './dom.js';
import { isConfigured, db, loadOverview } from './api.js';
import { checkMember, signOut } from './auth.js';
import { loginScreen } from './screens/login.js';
import { homeScreen } from './screens/home.js';
import { fundsScreen } from './screens/funds.js';
import { searchScreen } from './screens/search.js';
import { chartScreen } from './screens/chart.js';
import { orderScreen } from './screens/order.js';
import { portfolioScreen } from './screens/portfolio.js';

const root = document.getElementById('app');
let me = null;
let cleanup = null; // 차트처럼 정리가 필요한 화면
let pendingNotice = null; // 강제 로그아웃 뒤 SIGNED_OUT 으로 다시 그려져도 안내가 남게

function nav() {
  const link = (hash, text) =>
    el('a', { text, attrs: { href: hash, 'aria-current': location.hash === hash ? 'page' : 'false' } });
  return el('nav', {}, [
    link('#/home', '홈'),
    link('#/search', '종목'),
    link('#/portfolio', '보유·주문'),
    link('#/funds', '추가 자금'),
    el('button', { text: '로그아웃', attrs: { type: 'button' }, on: { click: () => signOut() } }),
  ]);
}

function show(...nodes) {
  cleanup?.();
  cleanup = nodes.find((n) => n && n._cleanup)?._cleanup ?? null;
  mount(root, ...nodes);
}

async function render() {
  if (!isConfigured()) return show(loginScreen('unconfigured'));
  const r = await checkMember();
  if (r.status !== 'ok') {
    me = null;
    if (r.status !== 'none') pendingNotice = r.status;
    const notice = pendingNotice;
    if (r.status === 'none') pendingNotice = null;
    return show(loginScreen(notice));
  }
  pendingNotice = null;
  me = r.me;
  let data;
  try {
    data = await loadOverview();
  } catch {
    return show(nav(), el('p', { className: 'notice', text: '잔고를 불러오지 못했습니다.' }));
  }
  let hash = location.hash;
  try {
    hash = decodeURIComponent(hash);
  } catch {
    hash = '#/home'; // 잘못된 % 인코딩이면 홈으로
  }
  const chartRoute = /^#\/chart\/(KR|US)\/([0-9A-Z.]{1,10})$/.exec(hash);
  const orderRoute = /^#\/order\/(KR|US)\/([0-9A-Z.]{1,10})$/.exec(hash);
  let screen;
  if (location.hash === '#/funds') screen = fundsScreen(data, me, () => {});
  else if (location.hash === '#/search') screen = searchScreen(me);
  else if (chartRoute) screen = chartScreen(me, chartRoute[1], chartRoute[2]);
  else if (orderRoute) screen = orderScreen(me, orderRoute[1], orderRoute[2]);
  else if (hash === '#/portfolio') screen = portfolioScreen(me, data);
  else screen = homeScreen(data, me);
  show(nav(), screen);
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
