// 장 시간 판단(정규장만). 시간대 계산은 Intl(IANA 시간대)로 → 서머타임 자동 반영.
//   KRX  09:00~15:30 Asia/Seoul        (요율표 §6, KRX 규정)
//   NYSE 09:30~16:00 America/New_York, 조기폐장일은 market_calendar.close_at (NYSE 공식 표)
// market_calendar 에 그날 행이 있으면 그 값을 따르고, 없으면 "평일이면 개장"으로 본다.

export type CalendarRow = { trade_date: string; is_open: boolean; open_at: string | null; close_at: string | null } | null;

type Parts = { date: string; minutes: number; weekday: number };

function partsIn(tz: string, now: Date): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: wd };
}

export const KR_TZ = 'Asia/Seoul';
export const US_TZ = 'America/New_York';

export function localDate(tz: string, now: Date): string {
  return partsIn(tz, now).date;
}

export function localHhmmss(tz: string, now: Date): string {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.hour}${p.minute}${p.second}`;
}

function isOpen(tz: string, openMin: number, closeMin: number, now: Date, row: CalendarRow, graceMin = 0): boolean {
  const p = partsIn(tz, now);
  if (row && row.trade_date === p.date) {
    if (!row.is_open) return false;
    const t = now.getTime();
    const openOk = row.open_at ? t >= Date.parse(row.open_at) : p.minutes >= openMin;
    const closeOk = row.close_at ? t < Date.parse(row.close_at) + graceMin * 60000 : p.minutes < closeMin + graceMin;
    return openOk && closeOk;
  }
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.minutes >= openMin && p.minutes < closeMin + graceMin;
}

// graceMin: 마감 뒤 몇 분 더 "열림"으로 볼지(마지막 1분봉 수집용). 체결 판단(M3)에는 0 을 쓴다.
export function isKrxOpen(now: Date, row: CalendarRow = null, graceMin = 0): boolean {
  return isOpen(KR_TZ, 9 * 60, 15 * 60 + 30, now, row, graceMin);
}

export function isNyseOpen(now: Date, row: CalendarRow = null, graceMin = 0): boolean {
  return isOpen(US_TZ, 9 * 60 + 30, 16 * 60, now, row, graceMin);
}
