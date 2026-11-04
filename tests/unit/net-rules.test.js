// 보안 검사 6번(서버 함수 외부 호출 제한) 우회 시도 시험
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netViolations } from '../../scripts/net-rules.mjs';

const F = 'supabase/functions/_shared/providers/x.ts';

test('우회 시도는 모두 걸린다', () => {
  const bad = [
    'await fetch("https://evil.test")',
    'const f = fetch; await f(u)',
    'await globalThis.fetch(u)',
    'await globalThis["fetch"](u)',
    "const g = self['fetch']",
    'const { fetch: go } = globalThis',
    'await window.fetch?.(u)',
    'import http from "node:http"',
    "import https from 'https'",
    "import net from 'node:net'",
    "import tls from 'node:tls'",
    "import cp from 'node:child_process'",
    "import axios from 'npm:axios@1.7.0'",
    "import nf from 'npm:node-fetch'",
    "import { request } from 'npm:undici@6/index.js'",
    "import got from 'npm:got'",
    "import ky from 'npm:ky@1'",
    'new WebSocket("wss://evil.test")',
    'await Deno.connect({ hostname: "evil.test", port: 443 })',
    'await Deno.connectTls({ hostname: "evil.test", port: 443 })',
    'new Deno.Command("curl", { args: [u] })',
    'Deno.run({ cmd: ["curl", u] })',
    'Deno.createHttpClient({})',
    'new XMLHttpRequest()',
    'new EventSource(u)',
  ];
  for (const line of bad) assert.ok(netViolations(F, line).length > 0, line);
});

test('허용: http.ts 안의 fetch, server.ts 의 어댑터 생성 줄, 주석, fetched_at 같은 다른 이름', () => {
  assert.deepEqual(netViolations('supabase/functions/_shared/http.ts', 'return fetchImpl(url, { ...init, redirect: "error" });\nexport type FetchLike = typeof fetch;'), []);
  assert.deepEqual(netViolations('supabase/functions/_shared/server.ts', "  return appKey && appSecret ? createKis({ appKey, appSecret, kv, transport: fetch }) : null;"), []);
  assert.deepEqual(netViolations(F, '// allowlist fetch 로만 부른다'), []);
  assert.deepEqual(netViolations(F, '/**\n * fetch 설명(블록 주석)\n */'), []);
  assert.deepEqual(netViolations(F, 'rows.map((r) => ({ ...r, fetched_at: now }))'), []);
  assert.deepEqual(netViolations('app/js/api.js', 'await fetch(u)'), [], '화면 코드는 이 규칙 대상 아님(CSP 가 막음)');
});

test('server.ts 라도 어댑터 생성 줄이 아니면 걸린다, http.ts 라도 다른 수단은 걸린다', () => {
  assert.ok(netViolations('supabase/functions/_shared/server.ts', 'const r = await fetch(u);').length > 0);
  assert.ok(netViolations('supabase/functions/_shared/server.ts', 'return createKis({ appKey, appSecret, kv, transport: (u) => fetch(u) }) ? 1 : null;').length > 0);
  assert.ok(netViolations('supabase/functions/_shared/http.ts', 'new WebSocket(u)').length > 0);
});

// ───────── SP-023: 리뷰(SP-022)가 지적한 우회 유형 11가지 ─────────
test('리뷰 지적 우회 11가지가 모두 걸린다', async () => {
  const { stripComments } = await import('../../scripts/net-rules.mjs');
  const cases = {
    '1 transport 직접 호출(L7)': 'const r = await deps.transport(url);',
    '2 문자열 이어붙이기': "const f = globalThis['fe' + 'tch'];",
    '3 Reflect.get': "const f = Reflect.get(globalThis, 'fe' + 'tch');",
    '4 유니코드 이스케이프 식별자': 'await globalThis.f\\u0065tch(u);',
    '5 URL import': "import axios from 'https://esm.sh/axios@1.7.0';",
    '6 jsr import': "import { serveDir } from 'jsr:@std/http@1';",
    '7 동적 import': "const m = await import('node:' + 'https');",
    '8 같은 줄 문자열 안 // 뒤에 숨기기': 'const u = "https://evil.test"; await fetch(u);',
    '9 * 로 시작하는 줄': '* 2; await fetch(u);',
    '10 Worker': "new Worker(new URL('./w.ts', import.meta.url).href, { type: 'module' });",
    '11 다른 프로젝트 createClient(R7)': "const c = createClient('https://evil.supabase.co', key);",
  };
  for (const [name, line] of Object.entries(cases)) assert.ok(netViolations(F, line).length > 0, name);
  // 여러 줄 import 도 허용 목록으로 검사
  assert.ok(netViolations(F, "import {\n  x,\n} from 'npm:axios';").length > 0, '여러 줄 import');
  assert.ok(netViolations(F, "export { x } from 'npm:got';").length > 0, 're-export');
  assert.ok(netViolations(F, "import 'npm:undici';").length > 0, '부수효과 import');
  assert.ok(netViolations(F, "import x from './a.ts?u=https://evil.test';").length > 0, '상대 경로에 URL 섞기');
  assert.ok(netViolations(F, "const SUPABASE_URL = 'https://evil.supabase.co';").length > 0, 'SUPABASE_URL 바꿔치기');
  assert.ok(netViolations(F, 'const x = 1; /* 주석 */ await fetch(u);').length > 0, '블록 주석 뒤 코드');
  // 주석 처리는 문자열을 지키고 주석만 지운다
  assert.equal(stripComments('a("http://x") // c'), 'a("http://x")     ');
  assert.equal(stripComments('/* a\nb */x'), '    \n    x');
});

test('허용: 지금 코드 모양(상대 import, supabase-js 고정 버전, 어댑터 연결, guardedFetch 에 transport 넘기기, 타입 선언)', () => {
  const ok = [
    "import { createClient } from 'npm:@supabase/supabase-js@2.118.0';",
    "import { guardedFetch, type AllowRule, type FetchLike } from '../http.ts';",
    "import type { Bar } from './kis.ts';",
    '  const f = guardedFetch(KIS_ALLOW, deps.transport);',
    '  transport: FetchLike; // 실제 네트워크 함수',
    'export type AlpacaDeps = { keyId: string; secretKey: string; transport: FetchLike };',
    "const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';",
    '  return createClient(SUPABASE_URL, PUBLISHABLE, {',
    "const u = 'https://data.alpaca.markets'; // 주소 문자열은 괜찮다",
  ];
  for (const line of ok) assert.deepEqual(netViolations(F, line), [], line);
  assert.deepEqual(netViolations('supabase/functions/_shared/server.ts',
    '  return keyId && secretKey ? createAlpaca({ keyId, secretKey, transport: fetch }) : null;'), []);
  assert.ok(netViolations(F, 'const t = deps.transport; t(u);').length > 0, 'transport 별칭');
  assert.ok(netViolations(F, 'const f = guardedFetch(KIS_ALLOW, (u) => deps.transport(u));').length > 0, 'guardedFetch 인자를 감싸기');
});
