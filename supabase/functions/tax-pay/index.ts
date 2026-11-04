// Edge Function: tax-pay (Deno). 본인 해외주식 양도세 납부(5월 1일~31일, DB 함수 sp.cgt_pay 가 기간·금액 확인).
import { ALLOWED_ORIGINS, callerOf, userRpc } from '../_shared/user-db.ts';
import { createTaxPayHandler } from '../fx-convert/handler.ts';

Deno.serve(createTaxPayHandler({
  allowedOrigins: ALLOWED_ORIGINS,
  getCaller: callerOf,
  cgtPay: (jwt, year) => userRpc(jwt, 'cgt_pay', { p_year: year }),
}));
