-- 0002_rls: 권한(GRANT)·RLS·도우미 함수
-- 새 Supabase 프로젝트는 테이블을 Data API 에 자동 노출하지 않으므로 필요한 권한만 명시한다.
-- anon 에는 아무것도 주지 않는다. 브라우저(authenticated)는 읽기 + 정해진 함수 실행만.

-- ───────── 기본 권한 정리 ─────────
revoke all on schema sp from public;
revoke all on all tables in schema sp from public, anon, authenticated;
revoke all on all sequences in schema sp from public, anon, authenticated;
revoke execute on all functions in schema sp from public, anon, authenticated;

-- 이후 이 스키마에 만드는 함수도 기본 실행 권한(PUBLIC)을 갖지 않게
alter default privileges in schema sp revoke execute on functions from public;

grant usage on schema sp to authenticated;

-- ───────── 도우미 ─────────
-- 로그인한 사람의 participant_id. 미등록이면 null.
create function sp.me() returns smallint
language sql stable security definer set search_path = '' as $$
  select participant_id from sp.allowed_users where auth_user_id = auth.uid()
$$;

revoke execute on function sp.me() from public;
grant execute on function sp.me() to authenticated;

-- ───────── 추가 자금 요청(브라우저·Edge Function 에서 사용자 JWT 로 호출) ─────────
-- 규칙: 호출자는 허용 계정이어야 함 / 받는 사람은 본인, 또는 봇이면서 호출자가 can_fund_bot
--       / 1회 상한은 app_settings(fund_max_krw, fund_max_usd).
create function sp.request_fund(p_to smallint, p_currency text, p_amount numeric)
returns table (participant_id smallint, currency text, balance numeric)
language plpgsql security definer set search_path = '' as $$
declare
  v_me       smallint;
  v_can_bot  boolean;
  v_kind     text;
  v_max      numeric;
  v_balance  numeric;
begin
  select a.participant_id, a.can_fund_bot into v_me, v_can_bot
    from sp.allowed_users a where a.auth_user_id = auth.uid();
  if v_me is null then
    raise exception 'not_registered' using errcode = '42501';
  end if;

  select p.kind into v_kind from sp.participants p where p.id = p_to;
  if v_kind is null then
    raise exception 'unknown_participant' using errcode = '22023';
  end if;

  if not (p_to = v_me or (v_kind = 'bot' and v_can_bot)) then
    raise exception 'forbidden_target' using errcode = '42501';
  end if;

  if p_currency not in ('KRW','USD') then
    raise exception 'invalid_currency' using errcode = '22023';
  end if;

  select s.value::numeric into v_max from sp.app_settings s
   where s.key = case p_currency when 'KRW' then 'fund_max_krw' else 'fund_max_usd' end;
  if v_max is null then
    raise exception 'limit_not_configured' using errcode = '22023';
  end if;
  if p_amount > v_max then
    raise exception 'over_limit' using errcode = '22023';
  end if;

  v_balance := sp.grant(p_to, p_currency, p_amount, 'add_fund', v_me);
  return query select p_to, p_currency, v_balance;
end $$;

revoke execute on function sp.request_fund(smallint, text, numeric) from public;
grant execute on function sp.request_fund(smallint, text, numeric) to authenticated;

-- sp.grant / 트리거 함수는 브라우저에서 실행 불가(위 revoke 로 public·anon·authenticated 모두 없음)

-- ───────── RLS ─────────
alter table sp.participants  enable row level security;
alter table sp.allowed_users enable row level security;
alter table sp.app_settings  enable row level security;
alter table sp.rate_table    enable row level security;
alter table sp.rate_bands    enable row level security;
alter table sp.accounts      enable row level security;
alter table sp.cash_ledger   enable row level security;
alter table sp.fund_grants   enable row level security;

-- 읽기: 허용 계정이면 세 참가자 모두(비교 화면)
grant select on sp.participants, sp.app_settings, sp.rate_table, sp.rate_bands,
                sp.accounts, sp.cash_ledger, sp.fund_grants
  to authenticated;

create policy member_read on sp.participants  for select to authenticated using (sp.me() is not null);
create policy member_read on sp.app_settings  for select to authenticated using (sp.me() is not null);
create policy member_read on sp.rate_table    for select to authenticated using (sp.me() is not null);
create policy member_read on sp.rate_bands    for select to authenticated using (sp.me() is not null);
create policy member_read on sp.accounts      for select to authenticated using (sp.me() is not null);
create policy member_read on sp.cash_ledger   for select to authenticated using (sp.me() is not null);
create policy member_read on sp.fund_grants   for select to authenticated using (sp.me() is not null);

-- allowed_users: 본인 행만 읽기(미등록 판정에 사용), 쓰기 없음(대시보드 SQL 로 등록)
grant select on sp.allowed_users to authenticated;
create policy own_row_read on sp.allowed_users for select to authenticated
  using (auth_user_id = auth.uid());

-- 쓰기: M1 에서는 브라우저가 어떤 테이블에도 직접 insert/update/delete 하지 않는다.
-- 추가 자금은 sp.request_fund(위) 만. 권한(GRANT)이 없으므로 RLS 이전에 거부된다.
