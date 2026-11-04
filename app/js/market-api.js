// 시세·종목·관심 종목·그림 읽고 쓰기(브라우저). 쓰기는 RLS 로 본인 행만 된다.
import { db } from './api.js';

const ok = ({ data, error }) => {
  if (error) throw error;
  return data;
};

// 이름·코드·티커 검색(이미 추가된 종목만). PostgREST or 필터 문법 문자는 지워서 넣는다
export async function searchInstruments(q) {
  const term = String(q ?? '').replace(/[%,().*:"\\]/g, ' ').trim().slice(0, 40);
  let query = db().from('instruments').select('market, symbol, name, exchange').eq('active', true).order('name').limit(30);
  if (term) query = query.or(`name.ilike.*${term}*,symbol.ilike.*${term}*`);
  return ok(await query);
}

export async function getInstrument(market, symbol) {
  return ok(await db().from('instruments').select('market, symbol, name, exchange, currency').eq('market', market).eq('symbol', symbol).maybeSingle());
}

export async function lookupInstrument(market, symbol) {
  const { data, error } = await db().functions.invoke('instrument-lookup', { body: { market, symbol } });
  if (error) {
    let code = 'server_error';
    try {
      const body = await error.context?.json?.();
      if (body?.error) code = body.error;
    } catch {
      /* 본문 없음 */
    }
    return { ok: false, error: code };
  }
  return data;
}

export async function myWatchlist() {
  return ok(await db().from('watchlist').select('market, symbol, added_at').order('added_at'));
}

export async function addWatch(participantId, market, symbol) {
  ok(await db().from('watchlist').insert({ participant_id: participantId, market, symbol }));
}

export async function removeWatch(market, symbol) {
  ok(await db().from('watchlist').delete().eq('market', market).eq('symbol', symbol));
}

export async function loadQuote(market, symbol) {
  return ok(await db().from('quotes').select('price, prev_close, open, high, low, volume, upper_limit, lower_limit, mode, quote_at, source')
    .eq('market', market).eq('symbol', symbol).maybeSingle());
}

// tf: '1m' 이면 최근 1분봉(최대 1000), '1d' 면 최근 일봉
export async function loadCandles(market, symbol, tf, limit = 1000) {
  const rows = ok(await db().from('candles').select('t, o, h, l, c, v').eq('market', market).eq('symbol', symbol).eq('tf', tf)
    .order('t', { ascending: false }).limit(limit));
  return rows.reverse();
}

export async function loadCalendarRow(market, date) {
  return ok(await db().from('market_calendar').select('trade_date, is_open, open_at, close_at').eq('market', market).eq('trade_date', date).maybeSingle());
}

export async function loadSetting(key) {
  const row = ok(await db().from('app_settings').select('value').eq('key', key).maybeSingle());
  return row?.value ?? null;
}

export async function loadDrawings(market, symbol, tf) {
  return ok(await db().from('drawings').select('id, participant_id, tool, points, style, label').eq('market', market).eq('symbol', symbol).eq('tf', tf).order('id'));
}

export async function saveDrawing(row) {
  return ok(await db().from('drawings').insert(row).select('id').single());
}

export async function updateDrawingPoints(id, points) {
  ok(await db().from('drawings').update({ points }).eq('id', id));
}

export async function deleteDrawing(id) {
  ok(await db().from('drawings').delete().eq('id', id));
}
