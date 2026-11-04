// 주문·보유·내역(브라우저). 주문·취소는 Edge Function(place-order·cancel-order), 읽기는 RLS 로.
import { db } from './api.js';

async function invoke(name, body) {
  const { data, error } = await db().functions.invoke(name, { body });
  if (error) {
    let code = 'server_error';
    try {
      const b = await error.context?.json?.();
      if (b?.error) code = b.error;
    } catch {
      /* 본문 없음 */
    }
    return { ok: false, error: code };
  }
  return data;
}

export const previewOrder = (o) => invoke('place-order', { ...o, dry_run: true });
export const placeOrder = (o) => invoke('place-order', { ...o, dry_run: false });
export const cancelOrder = (orderId) => invoke('cancel-order', { order_id: orderId });

const ok = ({ data, error }) => {
  if (error) throw error;
  return data;
};

export async function loadPositions(participantId) {
  return ok(await db().from('positions').select('market, symbol, qty, cost_local_open').eq('participant_id', participantId));
}

export async function loadQuotes(keys) {
  if (keys.length === 0) return [];
  const symbols = [...new Set(keys.map((k) => k.symbol))];
  return ok(await db().from('quotes').select('market, symbol, price, quote_at, mode').in('symbol', symbols));
}

export async function loadOrders(participantId, limit = 50) {
  return ok(await db().from('orders')
    .select('id, market, symbol, side, order_type, qty, limit_price, status, reject_reason, trade_date, fill_basis, reserved_amount, created_at, created_by')
    .eq('participant_id', participantId).order('created_at', { ascending: false }).limit(limit));
}

export async function loadFills(orderIds) {
  if (orderIds.length === 0) return [];
  return ok(await db().from('fills').select('order_id, at, price, qty, gross, broker_fee, reg_fee, tx_tax, cash_delta, quote_source').in('order_id', orderIds));
}
