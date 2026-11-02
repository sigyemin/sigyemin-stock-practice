-- 0001_core: sp 스키마 핵심 테이블 (M1 범위)
-- participants, allowed_users, app_settings, rate_table, rate_bands, accounts, cash_ledger, fund_grants
-- 원칙
--   * 돈은 numeric. 원화는 원 단위 정수, 달러는 센트(소수 2자리)까지.
--   * 잔고 원본은 cash_ledger. accounts.balance 는 원장 합계 캐시(트리거만 갱신).
--   * 실명·이메일 컬럼 없음. 허용 계정은 auth.users 의 id 만 allowed_users 에 등록(대시보드 SQL).

create schema if not exists sp;

-- ───────── 참가자·허용 계정 ─────────
create table sp.participants (
  id           smallint primary key,                 -- 1=민, 2=뽀, 3=봇
  alias        text not null unique check (alias in ('민','뽀','봇')),
  kind         text not null check (kind in ('human','bot')),
  strategy_id  text                                   -- 봇만
);

create table sp.allowed_users (
  auth_user_id   uuid primary key references auth.users(id) on delete cascade,
  participant_id smallint not null unique references sp.participants(id),
  can_fund_bot   boolean not null default false
);

-- ───────── 앱 설정 ─────────
create table sp.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  note       text
);

-- ───────── 요율표(유효기간) ─────────
create table sp.rate_table (
  id         bigserial primary key,
  code       text not null,
  market     text not null check (market in ('KR','US','FX','ALL')),
  segment    text,
  value      numeric not null,
  unit       text not null,
  valid_from date not null,
  valid_to   date,
  source_url text not null,
  checked_on date not null,
  note       text,
  check (valid_to is null or valid_to >= valid_from)
);
create index on sp.rate_table (code, valid_from);

create table sp.rate_bands (
  code       text not null,
  valid_from date not null,
  valid_to   date,
  bands      jsonb not null,
  source_url text not null,
  checked_on date not null,
  note       text,
  primary key (code, valid_from),
  check (valid_to is null or valid_to >= valid_from)
);

-- ───────── 계좌·원장 ─────────
create table sp.accounts (
  id             bigserial primary key,
  participant_id smallint not null references sp.participants(id),
  currency       text not null check (currency in ('KRW','USD')),
  balance        numeric not null default 0,
  unique (participant_id, currency),
  constraint accounts_usd_nonneg check (currency = 'KRW' or balance >= 0)
);

create table sp.cash_ledger (
  id          bigserial primary key,
  account_id  bigint not null references sp.accounts(id),
  at          timestamptz not null default now(),
  kind        text not null check (kind in (
                'seed','add_fund',
                'buy','sell','broker_fee','reg_fee',
                'tx_tax',
                'dividend','dividend_tax',
                'fx_out','fx_in',
                'cgt_payment',
                'adjust')),
  amount      numeric not null,
  ref_table   text,
  ref_id      bigint,
  memo        text
);
create index on sp.cash_ledger (account_id, at);

create table sp.fund_grants (
  id             bigserial primary key,
  participant_id smallint not null references sp.participants(id),
  granted_by     smallint references sp.participants(id),
  currency       text not null check (currency in ('KRW','USD')),
  amount         numeric not null check (amount > 0),
  kind           text not null check (kind in ('seed','add_fund')),
  at             timestamptz not null default now(),
  check (kind = 'seed' or granted_by is not null)
);

-- ───────── 원장 → 잔고 트리거 ─────────
-- 원장 insert 마다 accounts.balance += amount. USD 계좌가 음수가 되면 check 제약으로 insert 전체가 실패한다.
create function sp.ledger_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update sp.accounts set balance = balance + new.amount where id = new.account_id;
  if not found then
    raise exception 'account % not found', new.account_id using errcode = '23503';
  end if;
  return new;
end $$;

create trigger cash_ledger_apply after insert on sp.cash_ledger
  for each row execute function sp.ledger_apply();

-- 원장은 추가만(append-only). 고칠 일이 있으면 'adjust' 줄을 새로 넣는다.
create function sp.ledger_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'cash_ledger is append-only' using errcode = '42501';
end $$;

create trigger cash_ledger_no_update before update or delete on sp.cash_ledger
  for each row execute function sp.ledger_immutable();

create trigger cash_ledger_no_truncate before truncate on sp.cash_ledger
  for each statement execute function sp.ledger_immutable();

-- ───────── 지급 함수(내부용) ─────────
-- fund_grants 1행 + 원장 1줄을 한 트랜잭션에. 금액 형식만 검사하고 권한은 검사하지 않는다
-- → 브라우저(anon·authenticated)에는 실행 권한을 주지 않는다(0002_rls.sql).
create function sp.grant(
  p_participant smallint,
  p_currency    text,
  p_amount      numeric,
  p_kind        text,
  p_granted_by  smallint
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_account bigint;
  v_grant   bigint;
  v_balance numeric;
begin
  if p_currency not in ('KRW','USD') then
    raise exception 'invalid currency' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;
  if p_currency = 'KRW' and p_amount <> trunc(p_amount) then
    raise exception 'KRW amount must be an integer' using errcode = '22023';
  end if;
  if p_currency = 'USD' and p_amount <> trunc(p_amount, 2) then
    raise exception 'USD amount allows at most 2 decimals' using errcode = '22023';
  end if;

  select id into v_account from sp.accounts
   where participant_id = p_participant and currency = p_currency;
  if v_account is null then
    raise exception 'account not found' using errcode = '22023';
  end if;

  insert into sp.fund_grants (participant_id, granted_by, currency, amount, kind)
  values (p_participant, p_granted_by, p_currency, p_amount, p_kind)
  returning id into v_grant;

  insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id)
  values (v_account, p_kind, p_amount, 'fund_grants', v_grant);

  select balance into v_balance from sp.accounts where id = v_account;
  return v_balance;
end $$;
