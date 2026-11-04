// Edge Function: cancel-order (Deno). 본인 예약·대기 주문만 취소(DB 함수 sp.cancel_order 가 확인).
import { ALLOWED_ORIGINS, callerOf, userRpc } from '../_shared/user-db.ts';
import { createCancelHandler } from '../place-order/handler.ts';

Deno.serve(createCancelHandler({
  allowedOrigins: ALLOWED_ORIGINS,
  getCaller: callerOf,
  placeOrder: (jwt, o) => userRpc(jwt, 'place_order', { p_market: o.market, p_symbol: o.symbol, p_side: o.side, p_type: o.type, p_qty: o.qty, p_limit: o.limit, p_dry_run: o.dry_run }),
  cancelOrder: (jwt, id) => userRpc(jwt, 'cancel_order', { p_order: id }),
}));
