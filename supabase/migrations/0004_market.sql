-- 0004_market: 시세·차트(M2) — instruments, market_calendar, quotes, candles, fx_rates, watchlist, drawings, server_kv
-- 원칙
--   * public 스키마에는 아무것도 만들지 않는다(sp 만).
--   * 브라우저(authenticated): 시세·종목·달력·환율 읽기, 자기 관심 종목·그림만 쓰기(RLS 로 본인 행만).
--   * 서버 함수(service_role, secret 키): 시세·종목·달력·환율 쓰기, server_kv 읽기·쓰기. 돈 테이블에는 권한 없음.
--   * kr_quote_mode 값은 바꾸지 않는다(키 입력 후 운영에서 전환).

-- ───────── 종목·달력 ─────────
create table sp.instruments (
  market     text not null check (market in ('KR','US')),
  symbol     text not null,
  name       text not null check (char_length(name) between 1 and 200),
  exchange   text not null check (exchange in ('KOSPI','KOSDAQ','NYSE','NASDAQ','NYSE_ARCA','NYSE_AMERICAN','OTHER')),
  currency   text not null check (currency in ('KRW','USD')),
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (market, symbol),
  check ((market = 'KR' and symbol ~ '^[0-9]{6}$' and currency = 'KRW')
      or (market = 'US' and symbol ~ '^[A-Z][A-Z.]{0,9}$' and currency = 'USD'))
);
create index on sp.instruments (lower(name));

create table sp.market_calendar (
  market     text not null check (market in ('KR','US')),
  trade_date date not null,
  is_open    boolean not null,
  open_at    timestamptz,
  close_at   timestamptz,
  note       text,
  source_url text,
  primary key (market, trade_date)
);

-- ───────── 시세 ─────────
create table sp.quotes (
  market      text not null,
  symbol      text not null,
  price       numeric not null check (price > 0),
  prev_close  numeric,
  open        numeric,
  high        numeric,
  low         numeric,
  volume      numeric,
  base_price  numeric,
  upper_limit numeric,
  lower_limit numeric,
  mode        text not null check (mode in ('realtime','delayed')),
  quote_at    timestamptz not null,
  source      text not null,
  fetched_at  timestamptz not null default now(),
  primary key (market, symbol),
  foreign key (market, symbol) references sp.instruments (market, symbol)
);

create table sp.candles (
  market text not null,
  symbol text not null,
  tf     text not null check (tf in ('1m','5m','1d')),
  t      timestamptz not null,
  o numeric not null, h numeric not null, l numeric not null, c numeric not null, v numeric,
  source text not null,
  primary key (market, symbol, tf, t),
  foreign key (market, symbol) references sp.instruments (market, symbol),
  check (h >= l and h >= o and h >= c and l <= o and l <= c)
);

create table sp.fx_rates (
  rate_date  date primary key,
  usdkrw     numeric not null check (usdkrw > 0),
  source     text not null,
  fetched_at timestamptz not null default now()
);

-- ───────── 관심 종목·차트 그림(브라우저가 본인 행만 씀) ─────────
create table sp.watchlist (
  participant_id smallint not null references sp.participants(id),
  market         text not null,
  symbol         text not null,
  added_at       timestamptz not null default now(),
  primary key (participant_id, market, symbol),
  foreign key (market, symbol) references sp.instruments (market, symbol)
);

create table sp.drawings (
  id             bigserial primary key,
  participant_id smallint not null references sp.participants(id),
  market         text not null,
  symbol         text not null,
  tf             text not null check (tf in ('1m','5m','1d')),
  tool           text not null check (tool in ('trendline','hline','vline','ray','rect','fib','text')),
  points         jsonb not null check (jsonb_typeof(points) = 'array' and jsonb_array_length(points) between 1 and 10),
  style          jsonb not null default '{}'::jsonb check (jsonb_typeof(style) = 'object' and pg_column_size(style) <= 2000),
  label          text check (char_length(label) <= 100),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (market, symbol) references sp.instruments (market, symbol)
);
create index on sp.drawings (market, symbol, tf);

create function sp.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger drawings_touch before update on sp.drawings
  for each row execute function sp.touch_updated_at();

-- 그림 주인(participant_id)·종목은 바꿀 수 없게(업데이트는 모양·이름만)
create function sp.drawings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.participant_id <> old.participant_id or new.market <> old.market or new.symbol <> old.symbol
     or new.tf <> old.tf or new.tool <> old.tool or new.created_at <> old.created_at then
    raise exception 'immutable drawing columns' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger drawings_guard before update on sp.drawings
  for each row execute function sp.drawings_guard();

-- ───────── 서버 전용 키-값(KIS 토큰 재사용, cron 확인 토큰) ─────────
create table sp.server_kv (
  key        text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  value      text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ───────── 권한 ─────────
-- 새 함수의 PUBLIC 실행 권한 정리(0002 의 전역 기본 권한이 있어도 명시)
revoke execute on function sp.touch_updated_at() from public, anon, authenticated;
revoke execute on function sp.drawings_guard() from public, anon, authenticated;

alter table sp.instruments     enable row level security;
alter table sp.market_calendar enable row level security;
alter table sp.quotes          enable row level security;
alter table sp.candles         enable row level security;
alter table sp.fx_rates        enable row level security;
alter table sp.watchlist       enable row level security;
alter table sp.drawings        enable row level security;
alter table sp.server_kv       enable row level security;  -- 정책 없음 = authenticated 는 0행(권한도 없음)

-- 브라우저 읽기(허용 계정만)
grant select on sp.instruments, sp.market_calendar, sp.quotes, sp.candles, sp.fx_rates, sp.watchlist, sp.drawings
  to authenticated;
create policy member_read on sp.instruments     for select to authenticated using (sp.me() is not null);
create policy member_read on sp.market_calendar for select to authenticated using (sp.me() is not null);
create policy member_read on sp.quotes          for select to authenticated using (sp.me() is not null);
create policy member_read on sp.candles         for select to authenticated using (sp.me() is not null);
create policy member_read on sp.fx_rates        for select to authenticated using (sp.me() is not null);
create policy own_read    on sp.watchlist       for select to authenticated using (participant_id = sp.me());
-- 그림은 다른 참가자 것도 볼 수 있다(화면에서 켜고 끄기)
create policy member_read on sp.drawings        for select to authenticated using (sp.me() is not null);

-- 브라우저 쓰기: 관심 종목·그림, 본인 행만
grant insert (participant_id, market, symbol) on sp.watchlist to authenticated;
grant delete on sp.watchlist to authenticated;
create policy own_insert on sp.watchlist for insert to authenticated with check (participant_id = sp.me());
create policy own_delete on sp.watchlist for delete to authenticated using (participant_id = sp.me());

grant insert (participant_id, market, symbol, tf, tool, points, style, label) on sp.drawings to authenticated;
grant update (points, style, label) on sp.drawings to authenticated;
grant delete on sp.drawings to authenticated;
grant usage on sequence sp.drawings_id_seq to authenticated;
create policy own_insert on sp.drawings for insert to authenticated with check (participant_id = sp.me());
create policy own_update on sp.drawings for update to authenticated
  using (participant_id = sp.me()) with check (participant_id = sp.me());
create policy own_delete on sp.drawings for delete to authenticated using (participant_id = sp.me());

-- 서버 함수(service_role): 시세 쓰기만. service_role 은 RLS 를 우회하므로 권한(GRANT)으로만 범위를 정한다.
grant usage on schema sp to service_role;
grant select on sp.app_settings, sp.rate_table, sp.rate_bands, sp.watchlist to service_role;
grant select, insert, update on sp.instruments, sp.market_calendar, sp.quotes, sp.candles, sp.fx_rates to service_role;
grant select, insert, update on sp.server_kv to service_role;

-- ───────── 설정값 ─────────
insert into sp.app_settings (key, value, note) values
  ('tick_max_symbols_kr', '20',     'tick-kr 한 번에 처리할 종목 수 상한(KIS 초당 호출 한도 고려)'),
  ('tick_max_symbols_us', '30',     'tick-us 한 번에 처리할 종목 수 상한'),
  ('tick_time_budget_ms', '100000', '함수 한 번 실행에서 외부 호출에 쓸 최대 시간(벽시계 150초 한도 안쪽)'),
  ('kis_call_gap_ms',     '70',     'KIS 연속 호출 간격(실전 초당 18건 한도 → 약 56ms 이상)'),
  ('backfill_days_1d',    '365',    '종목 처음 추가 때 받을 일봉 기간(일)');

-- ───────── NYSE 휴장·조기폐장(공식 표: https://www.nyse.com/markets/hours-calendars, 2026-11-02 확인) ─────────
insert into sp.market_calendar (market, trade_date, is_open, close_at, note, source_url)
select 'US', d::date, false, null, n, 'https://www.nyse.com/markets/hours-calendars'
from (values
  ('2026-01-01','New Year''s Day'), ('2026-01-19','MLK Day'), ('2026-02-16','Washington''s Birthday'),
  ('2026-04-03','Good Friday'), ('2026-05-25','Memorial Day'), ('2026-06-19','Juneteenth'),
  ('2026-07-03','Independence Day'), ('2026-09-07','Labor Day'), ('2026-11-26','Thanksgiving'),
  ('2026-12-25','Christmas'),
  ('2027-01-01','New Year''s Day'), ('2027-01-18','MLK Day'), ('2027-02-15','Washington''s Birthday'),
  ('2027-03-26','Good Friday'), ('2027-05-31','Memorial Day'), ('2027-06-18','Juneteenth'),
  ('2027-07-05','Independence Day'), ('2027-09-06','Labor Day'), ('2027-11-25','Thanksgiving'),
  ('2027-12-24','Christmas')
) as h(d, n);

insert into sp.market_calendar (market, trade_date, is_open, close_at, note, source_url)
select 'US', d::date, true, (d || ' 13:00:00 America/New_York')::timestamptz, 'Early close 1:00 p.m.',
       'https://www.nyse.com/markets/hours-calendars'
from (values ('2026-11-27'), ('2026-12-24'), ('2027-11-26')) as e(d);
