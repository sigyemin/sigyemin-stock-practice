// 원·달러 표시(순수 함수)
const krw = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatKRW(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return `${krw.format(v)}원`;
}

export function formatUSD(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const s = usd.format(Math.abs(v));
  return v < 0 ? `-$${s}` : `$${s}`;
}

export function formatMoney(currency, n) {
  return currency === 'USD' ? formatUSD(n) : formatKRW(n);
}
