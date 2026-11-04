// tick-us: 장중 1분마다(cron). Alpaca(IEX)로 관심 종목 스냅샷·1분봉 수집.
import { cronHandler, jobDb, alpacaFromEnv } from '../_shared/server.ts';
import { runTickUs } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db) => runTickUs({ db: jobDb(db), alpaca: alpacaFromEnv(), now: () => new Date() })));
