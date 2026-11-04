// tick-kr: 장중 1분마다(cron). kr_quote_mode=realtime 일 때만 KIS 로 관심 종목 현재가·1분봉 수집.
import { cronHandler, jobDb, kisFromEnv } from '../_shared/server.ts';
import { runTickKr } from '../_shared/jobs.ts';

Deno.serve(cronHandler((db, kv) =>
  runTickKr({ db: jobDb(db), kis: kisFromEnv(kv), now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })));
