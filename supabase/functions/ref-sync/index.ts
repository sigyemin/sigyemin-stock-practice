// ref-sync: 주 1회(cron). 한국 휴장일(KIS chk-holiday) 갱신. 미국 휴장일은 마이그레이션의 NYSE 공식 표.
import { cronHandler, jobDb, kisFromEnv } from '../_shared/server.ts';
import { runRefSync } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db, kv) => runRefSync({ db: jobDb(db), kis: kisFromEnv(kv), now: () => new Date() })));
