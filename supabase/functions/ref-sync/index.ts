// ref-sync: 하루 1회(cron). 한국 휴장일(KIS chk-holiday) + 배당 일정(KIS ksdinfo/dividend, Alpaca corporate-actions).
// 미국 휴장일은 마이그레이션의 NYSE 공식 표.
import { cronHandler, jobDb, kisFromEnv, alpacaFromEnv } from '../_shared/server.ts';
import { runRefSync } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db, kv) => runRefSync({ db: jobDb(db), kis: kisFromEnv(kv), alpaca: alpacaFromEnv(), now: () => new Date() })));
