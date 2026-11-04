// Edge Function: place-order (Deno). 로직은 handler.ts, 주문 판단은 DB 함수 sp.place_order.
import { ALLOWED_ORIGINS, callerOf, userRpc } from '../_shared/user-db.ts';
import { createPlaceHandler } from './handler.ts';

Deno.serve(createPlaceHandler({
  allowedOrigins: ALLOWED_ORIGINS,
  getCaller: callerOf,
  placeOrder: (jwt, o) => userRpc(jwt, 'place_order', {
    p_market: o.market, p_symbol: o.symbol, p_side: o.side, p_type: o.type, p_qty: o.qty, p_limit: o.limit, p_dry_run: o.dry_run,
  }),
  cancelOrder: (jwt, id) => userRpc(jwt, 'cancel_order', { p_order: id }),
}));
