-- 로컬 시험용: Supabase 의 pg_cron·pg_net·Vault 가 주는 함수 모양만 흉내 낸다(실제 확장 아님).
-- Supabase 처럼 확장 객체의 주인은 별도 관리 역할(supabase_admin)이고, postgres 에 실행 권한을 준다.
-- → 0002 의 전역 기본 권한 revoke(for role postgres)가 이 함수들에 영향을 주지 않는지 본다.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin nologin;
  end if;
end $$;

create schema cron authorization supabase_admin;
create schema net authorization supabase_admin;
create schema vault authorization supabase_admin;

set role supabase_admin;

create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid::bigint
$$;

create table net.calls (id serial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                              headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint
language sql as $$
  insert into net.calls (url, headers, body, timeout_milliseconds) values (url, headers, body, timeout_milliseconds) returning id::bigint
$$;

create table vault.secrets (id serial primary key, name text unique, secret text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text) returns int
language sql as $$ insert into vault.secrets (name, secret) values (new_name, new_secret) returning id $$;

reset role;

-- supabase_admin 이 만든 함수는 postgres 의 기본 권한 설정과 무관하게 PUBLIC 실행 권한을 갖는다(PG 기본).
-- Supabase 에서 postgres 가 이 함수들을 쓰는 것처럼 명시적으로 허용
grant usage on schema cron, net, vault to postgres;
grant all on all tables in schema cron, net, vault to postgres;
grant all on all sequences in schema cron, net, vault to postgres;
grant execute on all functions in schema cron, net, vault to postgres;
