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
  assert.deepEqual(netViolations(F, ' * fetch 설명(블록 주석)'), []);
  assert.deepEqual(netViolations(F, 'rows.map((r) => ({ ...r, fetched_at: now }))'), []);
  assert.deepEqual(netViolations('app/js/api.js', 'await fetch(u)'), [], '화면 코드는 이 규칙 대상 아님(CSP 가 막음)');
});

test('server.ts 라도 어댑터 생성 줄이 아니면 걸린다, http.ts 라도 다른 수단은 걸린다', () => {
  assert.ok(netViolations('supabase/functions/_shared/server.ts', 'const r = await fetch(u);').length > 0);
  assert.ok(netViolations('supabase/functions/_shared/server.ts', 'return createKis({ appKey, appSecret, kv, transport: (u) => fetch(u) }) ? 1 : null;').length > 0);
  assert.ok(netViolations('supabase/functions/_shared/http.ts', 'new WebSocket(u)').length > 0);
});
