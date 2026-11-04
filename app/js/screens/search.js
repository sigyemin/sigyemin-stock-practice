// 종목 검색 + 관심 종목. 아직 추가되지 않은 종목은 코드(KR 6자리)·티커(US)로 추가한다.
import { el } from '../dom.js';
import { KR_CODE, US_TICKER } from '../chart-data.js';
import { searchInstruments, lookupInstrument, myWatchlist, addWatch, removeWatch } from '../market-api.js';

const EXCHANGE = { KOSPI: '코스피', KOSDAQ: '코스닥', NYSE: 'NYSE', NASDAQ: 'NASDAQ', NYSE_ARCA: 'NYSE Arca', NYSE_AMERICAN: 'NYSE American', OTHER: '기타' };
const LOOKUP_ERR = {
  not_found: '그 코드·티커의 주식을 찾지 못했습니다(ETF 등은 아직 지원하지 않습니다).',
  provider_not_configured: '시세 공급자 키가 아직 설정되지 않았습니다.',
  invalid_symbol: '코드 형식을 확인해 주세요(한국 6자리 숫자, 미국 영문 티커).',
  not_registered: '등록되지 않은 계정입니다.',
};

const chartHref = (i) => `#/chart/${i.market}/${encodeURIComponent(i.symbol)}`;

export function searchScreen(me) {
  const list = el('ul', { className: 'list' });
  const watch = el('ul', { className: 'list' });
  const status = el('p', { className: 'notice', attrs: { role: 'status' } }); // 추가·관심 버튼 결과
  const hint = el('p', { className: 'muted small' }); // 검색 결과 안내
  const input = el('input', { attrs: { type: 'search', placeholder: '종목 이름·코드·티커', autocomplete: 'off', 'aria-label': '종목 검색' } });
  const market = el('select', { attrs: { 'aria-label': '시장' } }, [
    el('option', { text: '한국', attrs: { value: 'KR' } }),
    el('option', { text: '미국', attrs: { value: 'US' } }),
  ]);
  let watched = new Set();

  const row = (i) => {
    const key = `${i.market}:${i.symbol}`;
    const on = watched.has(key);
    const btn = el('button', {
      text: on ? '관심 해제' : '관심 추가',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          btn.disabled = true;
          try {
            if (watched.has(key)) await removeWatch(i.market, i.symbol);
            else await addWatch(me.participantId, i.market, i.symbol);
            await refreshWatch();
            await runSearch();
          } catch {
            status.textContent = '관심 종목을 바꾸지 못했습니다.';
          }
          btn.disabled = false;
        },
      },
    });
    return el('li', {}, [
      el('a', { text: `${i.name} (${i.symbol})`, attrs: { href: chartHref(i) } }),
      el('span', { className: 'muted', text: ` ${EXCHANGE[i.exchange] ?? ''}` }),
      btn,
    ]);
  };

  async function refreshWatch() {
    try {
      const w = await myWatchlist();
      watched = new Set(w.map((x) => `${x.market}:${x.symbol}`));
      watch.replaceChildren(...(w.length ? w.map((x) => el('li', {}, [el('a', { text: `${x.symbol}`, attrs: { href: chartHref(x) } })]))
        : [el('li', { className: 'muted', text: '관심 종목이 없습니다. 관심 종목만 1분마다 시세를 받습니다.' })]));
    } catch {
      watch.replaceChildren(el('li', { className: 'muted', text: '관심 종목을 불러오지 못했습니다.' }));
    }
  }

  async function runSearch() {
    try {
      const rows = await searchInstruments(input.value);
      list.replaceChildren(...rows.map(row));
      hint.textContent = rows.length === 0 ? '찾는 종목이 없으면 시장을 고르고 코드·티커로 추가하세요.' : '';
    } catch {
      hint.textContent = '검색하지 못했습니다.';
    }
  }

  const addBtn = el('button', {
    text: '코드로 추가',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        const raw = input.value.trim();
        const m = market.value;
        if (!(m === 'KR' ? KR_CODE : US_TICKER).test(raw)) {
          status.textContent = LOOKUP_ERR.invalid_symbol;
          return;
        }
        addBtn.disabled = true;
        status.textContent = '종목 정보를 받는 중…';
        const res = await lookupInstrument(m, raw.toUpperCase());
        addBtn.disabled = false;
        if (res?.ok) {
          status.textContent = res.created ? `추가했습니다: ${res.instrument.name}` : `이미 있는 종목: ${res.instrument.name}`;
          await runSearch();
        } else {
          status.textContent = LOOKUP_ERR[res?.error] ?? '종목을 추가하지 못했습니다.';
        }
      },
    },
  });

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 250);
  });

  refreshWatch().then(runSearch);

  return el('section', {}, [
    el('h1', { text: '종목' }),
    el('div', { className: 'card stack' }, [el('div', { className: 'row' }, [input, market, addBtn]), status, hint, list]),
    el('h2', { text: '내 관심 종목' }),
    el('div', { className: 'card' }, [watch]),
  ]);
}
