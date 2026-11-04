// 장 시간 판단(화면 배지용). 서버 supabase/functions/_shared/market-time.ts 와 같은 규칙 —
// 두 구현이 같은 답을 내는지 tests/unit/chart-data.test.js 가 검사한다.
function partsIn(tz, now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

const RULES = {
  KR: { tz: 'Asia/Seoul', open: 9 * 60, close: 15 * 60 + 30 },
  US: { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
};

export function marketDate(market, now) {
  return partsIn(RULES[market].tz, now).date;
}

export function isMarketOpen(market, now, row = null) {
  const r = RULES[market];
  const p = partsIn(r.tz, now);
  if (row && row.trade_date === p.date) {
    if (!row.is_open) return false;
    const t = now.getTime();
    const openOk = row.open_at ? t >= Date.parse(row.open_at) : p.minutes >= r.open;
    const closeOk = row.close_at ? t < Date.parse(row.close_at) : p.minutes < r.close;
    return openOk && closeOk;
  }
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.minutes >= r.open && p.minutes < r.close;
}

export function marketTimezone(market) {
  return RULES[market].tz;
}
