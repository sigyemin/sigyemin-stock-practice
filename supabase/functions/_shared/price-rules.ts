// 한국 호가단위·상하한가(순수 함수). 구간·비율은 요율표(rate_bands KR_TICK, rate_table KR_PRICE_LIMIT)에서 받는다.
// 상·하한가 계산 순서(KRX 규정, 요율표 §1.1): 기준가 × 비율 → 기준가의 호가단위 미만 절사 → 기준가에 더하고 빼기
//   → 그 가격의 호가단위 미만 절사.  예: 기준 9,980 → 12,970 / 6,990

export type Band = { lt: number | null; tick: number | null };

export function tickFor(price: number, bands: Band[]): number {
  for (const b of bands) {
    if (b.lt === null || price < b.lt) {
      if (b.tick === null) throw new RangeError(`tick unknown for ${price}`);
      return b.tick;
    }
  }
  throw new RangeError('bands incomplete');
}

const floorTo = (x: number, step: number) => Math.floor(x / step) * step;

export function krLimits(base: number, ratio: number, bands: Band[]): { upper: number; lower: number } {
  const range = floorTo(base * ratio, tickFor(base, bands));
  const up = base + range;
  const down = base - range;
  return { upper: floorTo(up, tickFor(up, bands)), lower: floorTo(down, tickFor(down, bands)) };
}

export function isOnTick(price: number, bands: Band[]): boolean {
  const t = tickFor(price, bands);
  return Math.abs(price / t - Math.round(price / t)) < 1e-9;
}
