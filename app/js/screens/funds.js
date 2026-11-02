// 추가 자금: 본인에게. can_fund_bot 이면 봇에게도. 실제 검사는 서버(fund-grant + DB)가 한다.
import { el } from '../dom.js';
import { formatMoney } from '../format.js';
import { requestFund } from '../api.js';

const ERRORS = {
  forbidden_target: '이 참가자에게는 지급할 수 없습니다.',
  forbidden: '권한이 없습니다.',
  not_registered: '등록되지 않은 계정입니다.',
  invalid_amount: '금액을 확인해 주세요(원화는 정수, 달러는 소수 둘째 자리까지).',
  over_limit: '1회 지급 상한을 넘었습니다.',
};

export function fundsScreen({ participants }, me, onDone) {
  const targets = participants.filter((p) => p.id === me.participantId || (p.kind === 'bot' && me.canFundBot));

  const toSel = el('select', { attrs: { id: 'fund-to' } },
    targets.map((p) => el('option', { text: p.id === me.participantId ? `${p.alias} (나)` : p.alias, attrs: { value: p.id } })));
  const curSel = el('select', { attrs: { id: 'fund-cur' } }, [
    el('option', { text: '원화(KRW)', attrs: { value: 'KRW' } }),
    el('option', { text: '달러(USD)', attrs: { value: 'USD' } }),
  ]);
  const amount = el('input', { attrs: { id: 'fund-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', required: 'true' } });
  const status = el('p', { className: 'notice', attrs: { role: 'status' } });
  const submit = el('button', { text: '지급', className: 'primary', attrs: { type: 'submit' } });

  const form = el('form', {
    className: 'card',
    on: {
      submit: async (ev) => {
        ev.preventDefault();
        const raw = amount.value.replaceAll(',', '').trim();
        if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
          status.textContent = ERRORS.invalid_amount;
          return;
        }
        submit.disabled = true;
        status.textContent = '처리 중…';
        const res = await requestFund(Number(toSel.value), curSel.value, raw);
        submit.disabled = false;
        if (res?.ok) {
          status.textContent = `지급 완료. 새 잔고 ${formatMoney(res.currency, res.balance)}`;
          amount.value = '';
          onDone?.();
        } else {
          status.textContent = ERRORS[res?.error] ?? '지급하지 못했습니다.';
        }
      },
    },
  }, [
    el('label', { text: '받는 사람', attrs: { for: 'fund-to' } }), toSel,
    el('label', { text: '통화', attrs: { for: 'fund-cur' } }), curSel,
    el('label', { text: '금액', attrs: { for: 'fund-amount' } }), amount,
    submit,
    status,
  ]);

  return el('section', {}, [el('h1', { text: '추가 자금' }), form]);
}
