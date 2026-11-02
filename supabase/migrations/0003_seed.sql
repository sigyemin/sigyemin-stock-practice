-- 0003_seed: 참가자 3, 계좌 6, 시드 지급, app_settings 초기값, 요율표 첫 데이터
-- 허용 계정(allowed_users)은 넣지 않는다 — 사용자가 대시보드 SQL 로 직접 등록.

-- ───────── 참가자·계좌 ─────────
insert into sp.participants (id, alias, kind, strategy_id) values
  (1, '민', 'human', null),
  (2, '뽀', 'human', null),
  (3, '봇', 'bot',   'ma_cross_v0.1');

insert into sp.accounts (participant_id, currency)
select p.id, c.currency
  from sp.participants p
 cross join (values ('KRW'), ('USD')) as c(currency);

-- ───────── 앱 설정 ─────────
insert into sp.app_settings (key, value, note) values
  ('kr_quote_mode',        'delayed',     'delayed(일봉 D+1) | realtime'),
  ('us_quote_mode',        'realtime',    null),
  ('kr_provider_delayed',  'krx_openapi', null),
  ('kr_provider_realtime', 'kis',         null),
  ('us_provider',          'alpaca',      null),
  ('quote_max_age_sec',    '120',         '시장가 거부 기준(초)'),
  ('seed_krw',             '10000000',    '참가자별 시드(원)'),
  ('seed_usd',             '10000',       '참가자별 시드(달러)'),
  ('fund_max_krw',         '100000000',   '추가 자금 1회 상한(실수 방지용)'),
  ('fund_max_usd',         '100000',      '추가 자금 1회 상한(실수 방지용)');

-- ───────── 시드 지급: 참가자마다 KRW·USD 각 1건 → fund_grants 6행 + 원장 6줄 ─────────
select sp.grant(p.id, c.currency,
                (select s.value::numeric from sp.app_settings s
                  where s.key = case c.currency when 'KRW' then 'seed_krw' else 'seed_usd' end),
                'seed', null)
  from sp.participants p
 cross join (values ('KRW'), ('USD')) as c(currency)
 order by p.id, c.currency;

-- ───────── 요율표: 한국 ─────────
-- unit: ratio(0.0005 = 0.05%) / ratio_of_tax(세액의 비율) / usd_per_share / usd_cap / krw
-- 시작일을 확인하지 못한 "현행" 값은 확인일(2026-11-02)부터 적용하고 note 에 적는다.
insert into sp.rate_table (code, market, segment, value, unit, valid_from, valid_to, source_url, checked_on, note) values
  ('KR_SEC_TX_TAX', 'KR', 'KOSPI',  0.0005, 'ratio', '2026-01-01', null,
   'https://www.law.go.kr/법령/증권거래세법시행령', '2026-11-02', '매도대금 기준'),
  ('KR_SEC_TX_TAX', 'KR', 'KOSDAQ', 0.0020, 'ratio', '2026-01-01', null,
   'https://www.law.go.kr/법령/증권거래세법시행령', '2026-11-02', '매도대금 기준'),
  ('KR_SEC_TX_TAX', 'KR', 'KOSPI',  0,      'ratio', '2025-01-01', '2025-12-31',
   'https://www.law.go.kr/법령/증권거래세법시행령/(35359,20250228)', '2026-11-02', '이력'),
  ('KR_SEC_TX_TAX', 'KR', 'KOSDAQ', 0.0015, 'ratio', '2025-01-01', '2025-12-31',
   'https://www.law.go.kr/법령/증권거래세법시행령/(35359,20250228)', '2026-11-02', '이력'),
  ('KR_AGRI_TAX',   'KR', 'KOSPI',  0.0015, 'ratio', '2013-08-27', null,
   'https://www.law.go.kr/법령/농어촌특별세법', '2026-11-02', '양도가액 기준, 코스닥 없음'),
  ('KR_PRICE_LIMIT','KR', null,     0.30,   'ratio', '2015-06-15', null,
   'https://regulation.krx.co.kr/contents/RGL/03/03010100/RGL03010100T5.jsp', '2026-11-02', '기준가격 대비 상하'),
  ('KR_BROKER_FEE', 'KR', null,     0.000140527, 'ratio', '2026-02-19', null,
   'https://securities.koreainvestment.com/main/customer/notice/Notice.jsp?cmd=TF04ga000002&num=46189', '2026-11-02',
   '잠정: 비대면 기본 요율 중 공식 확인된 최저값. 더 싼 기본 요율 확인 시 교체'),
  ('KR_REG_FEE',    'KR', null,     0.000036396, 'ratio', '2025-03-04', null,
   'https://securities.koreainvestment.com/main/customer/guide/_static/TF04ae010000.jsp', '2026-11-02',
   '유관기관 제비용, 매수·매도 모두. 시작일은 표 기준일'),
  ('KR_DIV_TAX',    'KR', null,     0.14,   'ratio', '2026-11-02', null,
   'https://www.law.go.kr/법령/소득세법', '2026-11-02', '배당 총액 기준. 시작일 미확인(현행): 확인일부터 적용'),
  ('KR_DIV_LOCAL_TAX','KR', null,   0.10,   'ratio_of_tax', '2026-11-02', null,
   'https://www.law.go.kr/법령/지방세법', '2026-11-02', '소득세의 10%. 시작일 미확인(현행): 확인일부터 적용');

-- ───────── 요율표: 미국 ─────────
insert into sp.rate_table (code, market, segment, value, unit, valid_from, valid_to, source_url, checked_on, note) values
  ('US_BROKER_FEE',   'US', null, 0.0025,    'ratio', '2026-11-02', null,
   'https://www.kbsec.com/go.able?linkcd=s06030701P100', '2026-11-02',
   '잠정: 온라인 기본 요율. 시작일 미확인: 확인일부터 적용. 더 싼 기본 요율 확인 시 교체'),
  ('US_SEC31',        'US', null, 0.0000206, 'ratio', '2026-04-04', null,
   'https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2', '2026-11-02',
   '매도금액 기준. 종료일은 다음 요율 공지 후 입력'),
  ('US_FINRA_TAF',    'US', null, 0.000195,  'usd_per_share', '2026-01-01', '2026-09-30',
   'https://www.govinfo.gov/content/pkg/FR-2026-09-23/pdf/2026-19393.pdf', '2026-11-02', '매도 주식 수 기준'),
  ('US_FINRA_TAF_CAP','US', null, 9.79,      'usd_cap', '2026-01-01', '2026-09-30',
   'https://www.govinfo.gov/content/pkg/FR-2026-09-23/pdf/2026-19393.pdf', '2026-11-02', '거래당 상한'),
  ('US_FINRA_TAF',    'US', null, 0,         'usd_per_share', '2026-10-01', '2026-12-31',
   'https://www.finra.org/sites/default/files/2026-09/SR-FINRA-2026-021.pdf', '2026-11-02',
   '한시 중단. SEC 효력 정지 여부는 미확인'),
  ('US_FINRA_TAF',    'US', null, 0.000195,  'usd_per_share', '2027-01-01', '2028-12-31',
   'https://www.govinfo.gov/content/pkg/FR-2026-09-23/pdf/2026-19393.pdf', '2026-11-02', null),
  ('US_FINRA_TAF_CAP','US', null, 9.79,      'usd_cap', '2027-01-01', '2028-12-31',
   'https://www.govinfo.gov/content/pkg/FR-2026-09-23/pdf/2026-19393.pdf', '2026-11-02', null),
  ('US_FINRA_TAF',    'US', null, 0.000232,  'usd_per_share', '2029-01-01', null,
   'https://www.govinfo.gov/content/pkg/FR-2026-09-23/pdf/2026-19393.pdf', '2026-11-02', null),
  ('US_FINRA_TAF_CAP','US', null, 11.61,     'usd_cap', '2029-01-01', null,
   'https://www.govinfo.gov/content/pkg/FR-2026-09-23/pdf/2026-19393.pdf', '2026-11-02', null),
  ('US_DIV_WHT',      'US', null, 0.15,      'ratio', '2026-11-02', null,
   'https://www.irs.gov/pub/irs-trty/korea.pdf', '2026-11-02', '배당 총액 기준. 시작일 미확인(현행): 확인일부터 적용'),
  ('KR_DIV_TAX_FOREIGN_EXTRA', 'KR', null, 0, 'ratio', '2026-11-02', null,
   'https://www.law.go.kr/법령/소득세법', '2026-11-02', '외국 원천징수 후 국내 추가 징수. 시작일 미확인(현행)'),
  ('US_CGT_RATE',     'US', null, 0.20,      'ratio', '2026-11-02', null,
   'https://www.law.go.kr/법령/소득세법', '2026-11-02', '과세표준 기준. 시작일 미확인(현행)'),
  ('US_CGT_LOCAL',    'US', null, 0.02,      'ratio', '2026-11-02', null,
   'https://www.law.go.kr/법령/지방세법', '2026-11-02', '잠정(관행값). 조문 미확인'),
  ('US_CGT_DEDUCTION','US', null, 2500000,   'krw', '2026-11-02', null,
   'https://www.law.go.kr/법령/소득세법', '2026-11-02', '연간 기본공제. 시작일 미확인(현행)');

-- ───────── 요율표: 환전 ─────────
insert into sp.rate_table (code, market, segment, value, unit, valid_from, valid_to, source_url, checked_on, note) values
  ('FX_SPREAD', 'FX', null, 0.01, 'ratio', '2026-11-02', null, 'decision:user', '2026-11-02', '기본 스프레드'),
  ('FX_PREF',   'FX', null, 0.90, 'ratio', '2026-11-02', null, 'decision:user', '2026-11-02', '우대율. 실효 = 스프레드 × (1 − 우대율)');

-- ───────── 구간표 ─────────
-- lt = 이 가격 미만이면 tick. lt 가 null 이면 나머지 전부.
insert into sp.rate_bands (code, valid_from, valid_to, bands, source_url, checked_on, note) values
  ('KR_TICK', '2023-01-25', null,
   '[{"lt":2000,"tick":1},{"lt":5000,"tick":5},{"lt":20000,"tick":10},{"lt":50000,"tick":50},{"lt":200000,"tick":100},{"lt":500000,"tick":500},{"lt":null,"tick":1000}]'::jsonb,
   'https://regulation.krx.co.kr/contents/RGL/03/03010100/RGL03010100T3.jsp', '2026-11-02',
   '코스피·코스닥 주권 공통(원). 시작일은 비공식 자료 기준'),
  ('US_TICK', '2026-11-02', null,
   '[{"lt":1,"tick":null},{"lt":null,"tick":0.01}]'::jsonb,
   'https://www.sec.gov/newsroom/speeches-statements/atkins-101525-statement-regarding-minimum-pricing-increments-access-fee-caps', '2026-11-02',
   '$1 이상 $0.01. $1 미만 단위는 미확인(null). 시작일 미확인: 확인일부터 적용');
