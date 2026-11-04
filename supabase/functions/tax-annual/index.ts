// tax-annual: 매일 한국 23:50(cron). 1월 1일 지난해 양도세 확정, 5월 31일 23:30 이후 자동 차감(DB 함수 sp.tax_annual).
import { cronHandler, jobDb } from '../_shared/server.ts';
import { runTaxAnnual } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db) => runTaxAnnual({ db: jobDb(db) })));
