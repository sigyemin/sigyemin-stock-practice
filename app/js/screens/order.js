// 주문 화면: 매수/매도, 시장가/지정가, 수량 → "미리 보기"(서버 dry_run) → "주문".
// 예상 가격·수수료·세금은 서버가 계산한 값만 보여 준다(브라우저에서 계산하지 않음).
import { el } from '../dom.js';
import { costRows, previewSummary, ORDER_ERRORS, currencyOf } from '../order-format.js';
import { formatMoney } from '../format.js';
import { previewOrder, placeOrder } from '../order-api.js';
import { getInstrument } from '../market-api.js';

export function orderScreen(me, market, symbol) {
  const title = el('h1', { text: `주문 ${symbol}` });
  const status = el('p', { className: 'notice', attrs: { role: 'status' } });
  const preview = el('div', { className: 'card stack' });
  let previewed = null; // 마지막 미리보기의 입력(바뀌면 다시 미리 보기)

  const radio = (name, value, label, checked) => {
    const id = `${name}-${value}`;
    const input = el('input', { attrs: { type: 'radio', name, id, value } });
    input.checked = checked;
    return [input, el('label', { text: label, attrs: { for: id } })];
  };
  const sideBox = el('div', { className: 'row', attrs: { role: 'radiogroup', 'aria-label': '매수 매도' } },
    [...radio('side', 'buy', '매수', true), ...radio('side', 'sell', '매도', false)]);
  const typeBox = el('div', { className: 'row', attrs: { role: 'radiogroup', 'aria-label': '주문 종류' } },
    [...radio('type', 'market', '시장가', true), ...radio('type', 'limit', '지정가', false)]);
  const qty = el('input', { attrs: { id: 'ord-qty', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: '1' } });
  const limit = el('input', { attrs: { id: 'ord-limit', type: 'text', inputmode: 'decimal', autocomplete: 'off', disabled: 'true' } });
  const previewBtn = el('button', { text: '미리 보기', attrs: { type: 'button' } });
  const orderBtn = el('button', { text: '주문', className: 'primary', attrs: { type: 'button', disabled: 'true' } });

  const read = () => {
    const side = sideBox.querySelector('input:checked').value;
    const type = typeBox.querySelector('input:checked').value;
    const q = qty.value.replaceAll(',', '').trim();
    const l = limit.value.replaceAll(',', '').trim();
    if (!/^\d+$/.test(q) || Number(q) < 1) return { error: 'invalid_qty' };
    if (type === 'limit' && !/^\d+(\.\d{1,4})?$/.test(l)) return { error: 'invalid_limit' };
    return { market, symbol, side, type, qty: Number(q), limit: type === 'limit' ? l : null };
  };
  const key = (o) => JSON.stringify(o);

  const invalidate = () => {
    previewed = null;
    orderBtn.disabled = true;
  };
  for (const n of [sideBox, typeBox, qty, limit]) n.addEventListener('input', invalidate);
  typeBox.addEventListener('change', () => {
    limit.disabled = typeBox.querySelector('input:checked').value !== 'limit';
    invalidate();
  });

  function showPreview(r, o) {
    const rows = costRows(market, o.side, r);
    preview.replaceChildren(...[
      el('p', { text: previewSummary(r) }),
      el('p', { className: 'muted small', text: `예상 가격 ${formatMoney(currencyOf(market), r.price)} × ${o.qty}주` }),
      el('dl', {}, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      Number(r.reserved_amount) > 0
        ? el('p', { className: 'muted small', text: `체결될 때까지 묶이는 돈: ${formatMoney(currencyOf(market), r.reserved_amount)}` })
        : null,
      el('p', { className: 'muted small', text: '실제 체결 가격·금액은 체결 때 서버가 정합니다.' }),
    ].filter(Boolean));
  }

  previewBtn.addEventListener('click', async () => {
    const o = read();
    if (o.error) {
      status.textContent = ORDER_ERRORS[o.error];
      return;
    }
    previewBtn.disabled = true;
    status.textContent = '계산 중…';
    const r = await previewOrder(o);
    previewBtn.disabled = false;
    if (r?.ok) {
      status.textContent = '';
      showPreview(r, o);
      previewed = key(o);
      orderBtn.disabled = false;
    } else {
      preview.replaceChildren();
      status.textContent = ORDER_ERRORS[r?.error] ?? '미리 보기를 하지 못했습니다.';
    }
  });

  orderBtn.addEventListener('click', async () => {
    const o = read();
    if (o.error || key(o) !== previewed) {
      status.textContent = '입력이 바뀌었습니다. 다시 미리 보기를 해 주세요.';
      invalidate();
      return;
    }
    orderBtn.disabled = true;
    status.textContent = '주문 중…';
    const r = await placeOrder(o);
    if (r?.ok) {
      const word = { filled: '체결되었습니다', open: '대기 주문으로 접수되었습니다', reserved: '예약 주문으로 접수되었습니다', rejected: '거부되었습니다' }[r.status] ?? r.status;
      status.textContent = `주문 ${word}.`;
      previewed = null;
    } else {
      orderBtn.disabled = false;
      status.textContent = ORDER_ERRORS[r?.error] ?? '주문하지 못했습니다.';
    }
  });

  getInstrument(market, symbol).then((i) => {
    if (i) title.textContent = `주문 ${i.name} (${i.symbol})`;
  }).catch(() => {});

  return el('section', {}, [
    el('p', {}, [el('a', { text: '← 차트', attrs: { href: `#/chart/${market}/${encodeURIComponent(symbol)}` } })]),
    title,
    el('div', { className: 'card stack' }, [
      sideBox,
      typeBox,
      el('label', { text: '수량(주)', attrs: { for: 'ord-qty' } }), qty,
      el('label', { text: `지정가(${currencyOf(market) === 'KRW' ? '원' : '달러'})`, attrs: { for: 'ord-limit' } }), limit,
      el('div', { className: 'row' }, [previewBtn, orderBtn]),
      status,
    ]),
    preview,
    el('p', { className: 'muted small', text: '정규장에만 체결됩니다. 장 밖 주문은 다음 거래일 예약, 지정가는 당일 마감까지 유효합니다.' }),
  ]);
}
