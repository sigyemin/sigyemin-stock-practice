// fx-sync: 평일 하루 1~2번(cron). 수출입은행 매매기준율 저장.
import { cronHandler, jobDb, eximFromEnv } from '../_shared/server.ts';
import { runFxSync } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db) => runFxSync({ db: jobDb(db), exim: eximFromEnv(), now: () => new Date() })));
