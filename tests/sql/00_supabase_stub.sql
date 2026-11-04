-- 로컬 Postgres 시험용: Supabase 가 기본 제공하는 것 중 마이그레이션이 쓰는 최소한만 흉내 낸다.
-- (역할 anon·authenticated·service_role, auth.users, auth.uid())  ※ 운영 DB 에는 적용하지 않는다.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;  -- Supabase 의 service_role 처럼 RLS 우회
  end if;
end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

-- Supabase 의 auth.uid() 와 같은 방식: 요청 JWT 의 sub
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;
