// daily-close: 매일 한국장·미국장 마감 뒤(cron). 결제일 환율·실현손익, 배당 권리 확정·지급(DB 함수 sp.daily_close).
import { cronHandler, jobDb } from '../_shared/server.ts';
import { runDailyClose } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db) => runDailyClose({ db: jobDb(db) })));
