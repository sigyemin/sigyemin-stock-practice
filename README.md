# sigyemin-stock-practice

가상 돈으로 하는 주식 매매 연습 웹앱(개발 중). **가상 매매만** 하며 실제 증권사 주문은 하지 않는다.

- 화면: GitHub Pages 정적 PWA(`app/`), 빌드 도구·프레임워크 없음
- 서버: Supabase(PostgreSQL + RLS, Auth 구글 로그인, Edge Function)

## 폴더

```
app/                  배포 폴더(index.html, config.js, js/, css/, vendor/)
supabase/migrations/  sp 스키마·RLS·시드
supabase/functions/   Edge Function(fund-grant)과 공용 모듈(_shared)
tests/unit/           node --test 단위 테스트
tests/sql/            로컬 Postgres 마이그레이션·RLS 테스트
scripts/              CI 보안 검사
```

## 테스트

```bash
npm test                 # 단위 테스트(Node 22+)
npm run check:security   # innerHTML·eval·new Function, 키 패턴, CSP meta, vendor SRI
npm run test:sql         # 로컬 Postgres(initdb) 또는 DATABASE_URL 의 빈 DB 에 마이그레이션 + RLS 테스트
```

## 설정

- `app/config.js` 에는 Supabase 프로젝트 URL 과 **publishable 키만** 넣는다. 다른 키·비밀번호는 저장소에 두지 않는다.
- 허용 계정 등록은 Supabase 대시보드 SQL 편집기에서 직접 한다(저장소에 계정 정보를 남기지 않는다).
