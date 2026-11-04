-- 운영 설정(M2 예약 실행). 마이그레이션이 아니다 — 0004 적용 + 함수 배포 뒤 운영에서 한 번 실행한다.
-- 근거: Supabase 문서 "Scheduling Edge Functions"(pg_cron + pg_net, 인증값은 Vault 권장)
--   https://supabase.com/docs/guides/functions/schedule-functions
-- 인증 방식(우리 쪽):
--   * 함수는 verify_jwt = false. 대신 x-cron-token 헤더를 sp.server_kv 'cron_token' 과 비교한다(함수 코드).
--   * cron_token 은 아래에서 DB 안에서 무작위로 만든다 → 사람이 값을 보거나 옮길 일이 없다.
--   * project_url·publishable_key 는 문서 예시대로 Vault 에 둔다(publishable 키는 공개 값).
--   * cron_token 을 Vault 가 아니라 sp.server_kv 에 두는 이유: 함수(service_role)가 비교하려고 읽어야 하는데
--     server_kv 는 service_role 에만 권한이 있어(브라우저·anon 0) Vault 를 함수에 열어 주는 것보다 범위가 좁다.
-- 다시 실행해도 된다(같은 이름의 작업은 덮어씀, 토큰은 이미 있으면 그대로).

-- 1) 확장(대시보드 Database > Extensions 에서 켜도 같다)
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- 2) Vault: 프로젝트 주소와 publishable 키(둘 다 공개 값, app/config.js 와 같음). 이미 있으면 건너뜀
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://cypwcghsxzrnjwtcrbzc.supabase.co', 'project_url');
  end if;
  if not exists (select 1 from vault.secrets where name = 'publishable_key') then
    perform vault.create_secret('sb_publishable_upK0xy9rPWyL6DdQ3-qMJw_2Wa68EDj', 'publishable_key');
  end if;
end $$;

-- 3) cron 확인 토큰(64자 무작위). 이미 있으면 그대로 둔다.
insert into sp.server_kv (key, value)
values ('cron_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- 4) 작업 등록. 넓게 깨우고 함수가 장 시간·휴장일·kr_quote_mode 를 보고 스스로 끝낸다(설계서 §1.1).
--    pg_cron 은 UTC 기준.
--    tick-kr  : 월~금 00:00~06:59 UTC = 한국 09:00~15:59, 매분
--    tick-us  : 월~금 13:00~21:59 UTC (서머타임 13:30~20:00 / 겨울 14:30~21:00 을 모두 덮음), 매분
--    fx-sync  : 월~금 02:20, 04:20 UTC = 한국 11:20, 13:20 (11시 전후 고시 뒤)
--    ref-sync : 일 22:40 UTC = 한국 월 07:40, 주 1회(KIS 휴장일 조회는 "가급적 1일 1회")
do $$
declare
  j record;
begin
  for j in
    select * from (values
      ('sp-tick-kr',  '* 0-6 * * 1-5',   'tick-kr'),
      ('sp-tick-us',  '* 13-21 * * 1-5', 'tick-us'),
      ('sp-fx-sync',  '20 2,4 * * 1-5',  'fx-sync'),
      ('sp-ref-sync', '40 22 * * 0',     'ref-sync')
    ) as v(name, schedule, fn)
  loop
    perform cron.schedule(j.name, j.schedule, format($job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/%s',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
          'x-cron-token', (select value from sp.server_kv where key = 'cron_token')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
      );
    $job$, j.fn));
  end loop;
end $$;

-- 5) 확인
select jobname, schedule, active from cron.job where jobname like 'sp-%' order by jobname;

-- 되돌리기(필요할 때만):
--   select cron.unschedule(jobname) from cron.job where jobname like 'sp-%';
--   delete from sp.server_kv where key = 'cron_token';
