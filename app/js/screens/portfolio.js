// 보유·주문 내역: 보유(평균단가·평가손익), 대기·예약 주문(취소), 주문·체결 내역(수수료·세금 줄별)
import { el } from '../dom.js';
import { formatMoney } from '../format.js';
import { STATUS_TEXT, ORDER_ERRORS, currencyOf, holdingView, costRows } from '../order-format.js';
import { loadPositions, loadQuotes, loadOrders, loadFills, cancelOrder } from '../order-api.js';

const sideText = (s) => (s === 'buy' ? '매수' : '매도');
const typeText = (t) => (t === 'market' ? '시장가' : '지정가');
const when = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

export function portfolioScreen(me, data) {
  const pick = el('select', { attrs: { 'aria-label': '참가자' } },
    data.participants.map((p) => el('option', { text: p.id === me.participantId ? `${p.alias} (나)` : p.alias, attrs: { value: p.id } })));
  pick.value = String(me.participantId);
  const holdings = el('div', { className: 'card' });
  const pending = el('div', { className: 'card' });
  const history = el('div', { className: 'card' });
  const status = el('p', { className: 'notice', attrs: { role: 'status' } });

  let seq = 0; // 참가자를 빨리 바꿀 때 늦게 온 이전 응답이 화면을 덮지 않게
  async function render() {
    const my = ++seq;
    const pid = Number(pick.value);
    const mine = pid === me.participantId;
    try {
      const [pos, orders] = await Promise.all([loadPositions(pid), loadOrders(pid)]);
      if (my !== seq) return;
      const quotes = await loadQuotes(pos);
      if (my !== seq) return;
      const price = (m, s) => quotes.find((q) => q.market === m && q.symbol === s)?.price;

      holdings.replaceChildren(...(pos.length ? pos.map((p) => {
        const v = holdingView(p, price(p.market, p.symbol));
        const cur = currencyOf(p.market);
        return el('div', { className: 'item' }, [
          el('a', { text: `${p.symbol}`, attrs: { href: `#/chart/${p.market}/${encodeURIComponent(p.symbol)}` } }),
          el('dl', {}, [
            el('dt', { text: '수량' }), el('dd', { text: `${v.qty}주` }),
            el('dt', { text: '평균단가(수수료 포함)' }), el('dd', { text: formatMoney(cur, v.avg) }),
            el('dt', { text: '평가금액' }), el('dd', { text: v.value == null ? '-' : formatMoney(cur, v.value) }),
            el('dt', { text: '평가손익' }), el('dd', { text: v.pnl == null ? '-' : formatMoney(cur, v.pnl), className: v.pnl < 0 ? 'neg' : '' }),
          ]),
        ]);
      }) : [el('p', { className: 'muted', text: '보유 종목이 없습니다.' })]));

      const active = orders.filter((o) => o.status === 'open' || o.status === 'reserved');
      pending.replaceChildren(...(active.length ? active.map((o) => {
        const cur = currencyOf(o.market);
        const line = `${o.symbol} ${sideText(o.side)} ${typeText(o.order_type)} ${o.qty}주` +
          (o.limit_price ? ` @ ${formatMoney(cur, o.limit_price)}` : '') + ` · ${STATUS_TEXT[o.status]} · ${o.trade_date}` +
          (o.fill_basis === '1d' ? ' · 일봉 기준' : '');
        const btn = mine && o.created_by === 'user'
          ? el('button', {
            text: '취소',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                btn.disabled = true;
                const r = await cancelOrder(o.id);
                status.textContent = r?.ok ? '주문을 취소했습니다.' : (ORDER_ERRORS[r?.error] ?? '취소하지 못했습니다.');
                render();
              },
            },
          })
          : null;
        return el('div', { className: 'row between item' }, [el('span', { text: line }), btn]);
      }) : [el('p', { className: 'muted', text: '대기·예약 주문이 없습니다.' })]));

      const fills = await loadFills(orders.filter((o) => o.status === 'filled').map((o) => o.id));
      if (my !== seq) return;
      history.replaceChildren(...(orders.length ? orders.map((o) => {
        const f = fills.find((x) => x.order_id === o.id);
        const cur = currencyOf(o.market);
        const head = `${when(o.created_at)} · ${o.symbol} ${sideText(o.side)} ${typeText(o.order_type)} ${o.qty}주 · ${STATUS_TEXT[o.status] ?? o.status}` +
          (o.reject_reason ? `(${ORDER_ERRORS[o.reject_reason] ?? o.reject_reason})` : '') + (o.created_by === 'bot' ? ' · 봇' : '');
        const body = f
          ? el('dl', {}, [el('dt', { text: '체결가' }), el('dd', { text: `${formatMoney(cur, f.price)} (${when(f.at)})` }),
            ...costRows(o.market, o.side, f).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])])
          : null;
        return el('div', { className: 'item' }, [el('p', { text: head }), body]);
      }) : [el('p', { className: 'muted', text: '주문 내역이 없습니다.' })]));
    } catch {
      if (my === seq) status.textContent = '내역을 불러오지 못했습니다.';
    }
  }
  pick.addEventListener('change', render);
  render();

  return el('section', {}, [
    el('div', { className: 'row between' }, [el('h1', { text: '보유·주문' }), pick]),
    status,
    el('h2', { text: '보유' }), holdings,
    el('h2', { text: '대기·예약 주문' }), pending,
    el('h2', { text: '주문·체결 내역(최근 50건)' }), history,
  ]);
}
