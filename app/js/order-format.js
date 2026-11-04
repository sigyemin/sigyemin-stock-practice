// 주문 미리보기·내역 표시용 순수 함수(브라우저·Node 시험 공용). 숫자는 서버(dry_run·fills)가 준 값만 쓴다.
import { formatMoney } from './format.js';

export const currencyOf = (market) => (market === 'US' ? 'USD' : 'KRW');

// 비용 줄(수수료·세금 줄별). 0 인 줄도 보여 준다(무엇이 0 인지도 정보)
export function costRows(market, side, r) {
  const cur = currencyOf(market);
  const m = (v) => formatMoney(cur, Number(v));
  const rows = [['체결금액', m(r.gross)], ['위탁 수수료', m(r.broker_fee)]];
  if (market === 'KR') {
    rows.push(['유관기관 제비용', m(r.reg_fee)]);
    if (side === 'sell') rows.push(['거래세·농특세', m(r.tx_tax)]);
  } else if (side === 'sell') {
    rows.push(['SEC·FINRA 수수료', m(r.reg_fee)]);
  }
  const delta = Number(r.cash_delta);
  rows.push([delta < 0 ? '계좌에서 나가는 돈' : '계좌로 들어오는 돈', m(Math.abs(delta))]);
  return rows;
}

export const STATUS_TEXT = {
  filled: '체결',
  open: '대기',
  reserved: '예약',
  cancelled: '취소',
  rejected: '거부',
  expired: '만료',
};

// 미리보기 결과 한 줄 설명
export function previewSummary(r) {
  if (r.status === 'filled') return '지금 현재가로 바로 체결됩니다(예상).';
  if (r.fill_basis === '1d') return `지연 모드: ${r.trade_date} 일봉으로 장 마감 뒤 처리됩니다.`;
  if (r.status === 'reserved') return `장이 열려 있지 않아 예약 주문으로 접수됩니다(${r.trade_date} 개장 때 처리).`;
  return `조건이 맞을 때까지 대기합니다(${r.trade_date} 장 마감까지 유효).`;
}

export const ORDER_ERRORS = {
  invalid_qty: '수량은 1주 이상 정수로 넣어 주세요.',
  invalid_limit: '지정가를 확인해 주세요.',
  tick_mismatch: '호가단위에 맞지 않는 가격입니다.',
  tick_unknown: '이 가격대는 호가단위를 확인하지 못해 주문할 수 없습니다.',
  price_limit: '상·하한가 밖의 가격입니다.',
  krw_negative: '원화 잔고가 마이너스라 원화 매수를 할 수 없습니다(매도·달러 매매·환전은 가능).',
  quote_stale: '시세가 2분 넘게 갱신되지 않아 시장가 주문을 받을 수 없습니다.',
  no_quote: '시세가 아직 없습니다.',
  insufficient_funds: '가용 잔고가 모자랍니다(대기 주문에 묶인 돈 제외).',
  insufficient_qty: '매도할 수 있는 수량이 모자랍니다(대기 매도 제외).',
  unknown_instrument: '추가되지 않은 종목입니다.',
  kr_delayed_orders_unavailable: '한국 시세가 지연 모드라 지금은 한국 주문을 받지 않습니다(실시간 모드로 돌아오면 가능).',
  not_cancellable: '이미 끝난 주문입니다.',
  not_found: '주문을 찾지 못했습니다.',
  not_registered: '등록되지 않은 계정입니다.',
  // 환전·양도세 납부(M4)
  invalid_direction: '환전 방향을 골라 주세요.',
  invalid_amount: '금액을 확인해 주세요(원화는 원 단위, 달러는 센트까지).',
  amount_too_small: '금액이 너무 작아 환전하면 0이 됩니다.',
  fx_stale: '최근 7일 안의 고시 환율이 없어 지금은 환전할 수 없습니다.',
  nothing_to_pay: '낼 세금이 없거나 이미 냈습니다.',
  not_payment_period: '납부 기간(5월 1일~31일)이 아닙니다.',
  invalid_year: '연도를 확인해 주세요.',
};

// 보유 평가(현재가 기준). 평균단가 = 수수료 포함 취득가 ÷ 수량
export function holdingView(p, price) {
  const qty = Number(p.qty);
  const cost = Number(p.cost_local_open);
  const avg = qty > 0 ? cost / qty : 0;
  const value = price == null ? null : Number(price) * qty;
  return { qty, avg, cost, value, pnl: value == null ? null : value - cost };
}
