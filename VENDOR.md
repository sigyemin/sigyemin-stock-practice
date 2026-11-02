# 외부 라이브러리

`app/vendor/` 에 두는 파일은 버전을 고정하고 SRI 해시로 확인한다. CI(`scripts/check-security.mjs`)가 `index.html` 의 `integrity` 값과 실제 파일·이 표의 해시가 같은지 검사한다.

| 파일 | 패키지 | 버전 | 출처 | 라이선스 | SRI (sha384) |
|---|---|---|---|---|---|
| `app/vendor/supabase-2.118.0.umd.js` | `@supabase/supabase-js` | 2.118.0 | npm 레지스트리 tarball `package/dist/umd/supabase.js` (수정 없음) | MIT | `sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK` |

- sha256: `ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3`
- 다시 받는 법: `npm pack @supabase/supabase-js@2.118.0` → 압축 풀고 `package/dist/umd/supabase.js` 복사 → `openssl dgst -sha384 -binary <파일> | openssl base64 -A`
- Edge Function(Deno)은 같은 버전을 `npm:@supabase/supabase-js@2.118.0` 으로 읽는다.
