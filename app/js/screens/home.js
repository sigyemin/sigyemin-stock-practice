// 임시 홈: 세 참가자 카드 — 원화·달러 잔고만(수익률은 이후 단계)
import { el } from '../dom.js';
import { formatKRW, formatUSD } from '../format.js';

export function homeScreen({ participants, accounts }, me) {
  const bal = (pid, cur) => accounts.find((a) => a.participant_id === pid && a.currency === cur)?.balance;
  const cards = participants.map((p) => {
    const krw = Number(bal(p.id, 'KRW'));
    return el('article', { className: p.id === me.participantId ? 'card person me' : 'card person' }, [
      el('h2', { text: p.id === me.participantId ? `${p.alias} (나)` : p.alias }),
      el('dl', {}, [
        el('dt', { text: '원화' }),
        el('dd', { text: formatKRW(krw), className: krw < 0 ? 'neg' : '' }),
        el('dt', { text: '달러' }),
        el('dd', { text: formatUSD(bal(p.id, 'USD')) }),
      ]),
    ]);
  });
  return el('section', {}, [el('h1', { text: '잔고' }), el('div', { className: 'grid' }, cards)]);
}
