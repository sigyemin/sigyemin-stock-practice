// 돈 끝자리 규칙(순수 함수). 이진 부동소수 오차를 피하려고 10진 문자열 → BigInt 로 계산한다.
//   floorWon   : 원 미만 절사          98.37  → 98
//   ceilCent   : 센트 미만 올림        0.0412 → 0.05   (SEC31·TAF)
//   roundCent  : 센트 미만 반올림      5.005  → 5.01   (위탁 수수료, 0.5 는 0 에서 먼 쪽)
// 입력은 number 또는 10진 문자열. 결과는 number.

type Decimal = { int: bigint; scale: number }; // 값 = int / 10^scale

function parseDecimal(x: number | string): Decimal {
  let s = typeof x === 'number' ? numberToPlain(x) : x.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new RangeError(`not a decimal: ${String(x)}`);
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  const [whole, frac = ''] = s.split('.');
  const int = BigInt(whole + frac) * (neg ? -1n : 1n);
  return { int, scale: frac.length };
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`not finite: ${n}`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // 지수 표기(예: 1e-7)를 일반 표기로
  const [mant, expStr] = s.toLowerCase().split('e');
  const exp = Number(expStr);
  const neg = mant.startsWith('-');
  const digits = mant.replace('-', '');
  const [w, f = ''] = digits.split('.');
  const all = w + f;
  const point = w.length + exp;
  let out: string;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + all;
  else if (point >= all.length) out = all + '0'.repeat(point - all.length);
  else out = all.slice(0, point) + '.' + all.slice(point);
  return (neg ? '-' : '') + out;
}

type Mode = 'floor' | 'ceil' | 'half_up';

function toPlaces(x: number | string, places: number, mode: Mode): number {
  const d = parseDecimal(x);
  if (d.scale <= places) return Number(d.int) / 10 ** d.scale;
  const div = 10n ** BigInt(d.scale - places);
  let q = d.int / div; // 0 쪽으로 자름
  const r = d.int % div;
  if (r !== 0n) {
    const pos = d.int > 0n;
    if (mode === 'floor' && !pos) q -= 1n;
    else if (mode === 'ceil' && pos) q += 1n;
    else if (mode === 'half_up') {
      const twice = (r < 0n ? -r : r) * 2n;
      if (twice >= div) q += pos ? 1n : -1n;
    }
  }
  return Number(q) / 10 ** places;
}

export function floorWon(x: number | string): number {
  return toPlaces(x, 0, 'floor');
}

export function ceilCent(x: number | string): number {
  return toPlaces(x, 2, 'ceil');
}

export function roundCent(x: number | string): number {
  return toPlaces(x, 2, 'half_up');
}

// 금액 형식 검사: 양수, KRW 는 정수, USD 는 소수 2자리까지
export function isValidAmount(currency: string, amount: unknown): boolean {
  if (typeof amount !== 'number' && typeof amount !== 'string') return false;
  let d: Decimal;
  try {
    d = parseDecimal(amount);
  } catch {
    return false;
  }
  if (d.int <= 0n) return false;
  if (currency === 'KRW') return d.scale === 0 || d.int % 10n ** BigInt(d.scale) === 0n;
  if (currency === 'USD') {
    if (d.scale <= 2) return true;
    return d.int % 10n ** BigInt(d.scale - 2) === 0n;
  }
  return false;
}
