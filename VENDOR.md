# 외부 라이브러리

`app/vendor/` 에 두는 파일은 버전을 고정하고 SRI 해시로 확인한다. CI(`scripts/check-security.mjs`)가 `index.html` 의 `integrity` 값과 실제 파일·이 표의 해시가 같은지 검사한다.

| 파일 | 패키지 | 버전 | 출처 | 라이선스 | SRI (sha384) |
|---|---|---|---|---|---|
| `app/vendor/supabase-2.118.0.umd.js` | `@supabase/supabase-js` | 2.118.0 | npm 레지스트리 tarball `package/dist/umd/supabase.js` (수정 없음) | MIT | `sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK` |
| `app/vendor/klinecharts-10.1.0.umd.min.js` | `klinecharts` | 10.1.0 | npm 레지스트리 tarball `package/dist/umd/klinecharts.min.js` (수정 없음) | Apache-2.0 | `sha384-PdxmZHfTETfZiWcY/lOW/FdSPI3RTThvwFZDXUCvqNbLhWIL6z0bmLCSd7BorO6s` |

- KLineChart sha256: `428b7c3bff6a74e121b4da8093bd0187d1c81b9fae8826f1143097280667a8a1`. 파일 안 검색(2026-11-04): `innerHTML`·`eval(`·`new Function`·`setAttribute('style')`·`cssText`·`<style>` 생성 0건, 스타일은 CSSOM(`.style.x =`)만 → CSP `style-src 'self'` 그대로 동작(인라인 스타일 허용 불필요). 네트워크 호출(fetch·XHR·WebSocket) 0건.
- supabase-js sha256: `ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3`
- 다시 받는 법: `npm pack <패키지>@<버전>` → 압축 풀고 `package/dist/umd/supabase.js` 복사 → `openssl dgst -sha384 -binary <파일> | openssl base64 -A`
- Edge Function(Deno)은 같은 버전을 `npm:@supabase/supabase-js@2.118.0` 으로 읽는다.
