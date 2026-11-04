// Edge Function: fx-convert (Deno). 본인 원화↔달러 계좌 사이 환전(DB 함수 sp.fx_convert). 봇 환전은 서버 함수 sp.fx_convert_bot 만.
import { ALLOWED_ORIGINS, callerOf, userRpc } from '../_shared/user-db.ts';
import { createFxHandler } from './handler.ts';

Deno.serve(createFxHandler({
  allowedOrigins: ALLOWED_ORIGINS,
  getCaller: callerOf,
  fxConvert: (jwt, i) => userRpc(jwt, 'fx_convert', { p_direction: i.direction, p_amount: i.amount, p_dry_run: i.dry_run }),
}));
