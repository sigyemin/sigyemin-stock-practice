-- 0005_kv_claim: server_kv 의 "간격 확인 + 기록"을 한 문장으로(동시 실행 두 개가 둘 다 통과하지 않게).
-- 쓰임: KIS 토큰 발급 간격(kis_token_issue_at). 서버 함수(service_role)만 실행.
-- 원자성: 행이 있으면 UPDATE ... WHERE updated_at < now() - 간격 (행 잠금으로 직렬화),
--         행이 없으면 INSERT ... ON CONFLICT DO NOTHING (동시에 넣으면 하나만 성공).
create function sp.kv_claim(p_key text, p_min_gap_ms integer) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_hit integer;
begin
  if p_min_gap_ms is null or p_min_gap_ms < 0 then
    raise exception 'invalid gap' using errcode = '22023';
  end if;

  update sp.server_kv
     set value = now()::text, updated_at = clock_timestamp()
   where key = p_key
     and updated_at < clock_timestamp() - make_interval(secs => p_min_gap_ms / 1000.0);
  get diagnostics v_hit = row_count;
  if v_hit = 1 then
    return true;
  end if;

  insert into sp.server_kv (key, value, updated_at) values (p_key, now()::text, clock_timestamp())
  on conflict (key) do nothing;
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;

revoke execute on function sp.kv_claim(text, integer) from public, anon, authenticated;
grant execute on function sp.kv_claim(text, integer) to service_role;
