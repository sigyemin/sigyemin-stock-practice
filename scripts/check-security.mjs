// CI 보안 검사(외부 의존성 없음). 실패 항목이 있으면 종료 코드 1.
//  1. 화면 코드(app/, vendor 제외)·Edge Function 에 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval( / new Function 0건
//  2. app/(vendor 제외)에 service_role / sb_secret_ / sk_ / secret 문자열 0건
//  3. 저장소 전체에 실제 키처럼 생긴 값 0건(sb_secret_…, JWT, sk_live/sk_test, PEM 개인키)
//  4. app/index.html 에 CSP meta 존재, vendor 스크립트에 integrity 속성 + VENDOR.md 의 해시와 일치
//  5. app/config.js 는 프로젝트 URL + publishable 키만, CSP connect-src 와 같은 호스트
//  6. supabase/functions 에서 외부 호출 수단은 _shared/http.ts(허용 목록) 안에서만 — scripts/net-rules.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { netViolations } from './net-rules.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const problems = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const text = (p) => readFileSync(p, 'utf8');
const isVendor = (r) => r.startsWith('app/vendor/');
const all = walk(ROOT).filter((p) => !/\.(png|jpg|ico|woff2?)$/i.test(p));

// 1. 위험한 DOM·코드 실행 API
const codeFiles = all.filter((p) => {
  const r = rel(p);
  return ((r.startsWith('app/') && !isVendor(r)) || r.startsWith('supabase/functions/')) && /\.(js|mjs|ts|html)$/.test(r);
});
const DANGER = [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/];
for (const p of codeFiles) {
  const lines = text(p).split('\n');
  lines.forEach((line, i) => {
    for (const re of DANGER) if (re.test(line)) problems.push(`${rel(p)}:${i + 1} 금지 API ${re}`);
  });
}

// 2. 공개 화면 코드의 키 관련 문자열
const appFiles = all.filter((p) => rel(p).startsWith('app/') && !isVendor(rel(p)));
const APP_KEY_WORDS = [/service_role/i, /sb_secret_/i, /\bsk_/, /secret/i];
for (const p of appFiles) {
  text(p).split('\n').forEach((line, i) => {
    for (const re of APP_KEY_WORDS) if (re.test(line)) problems.push(`${rel(p)}:${i + 1} 키 관련 문자열 ${re}`);
  });
}

// 3. 실제 키 모양(저장소 전체, vendor 포함)
const KEY_SHAPES = [
  /sb_secret_[A-Za-z0-9_-]{16,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bsk_(live|test)_[A-Za-z0-9]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
for (const p of all) {
  if (rel(p) === 'scripts/check-security.mjs') continue;
  text(p).split('\n').forEach((line, i) => {
    for (const re of KEY_SHAPES) if (re.test(line)) problems.push(`${rel(p)}:${i + 1} 키처럼 보이는 값 ${re}`);
  });
}

// 4. CSP meta + vendor SRI
const html = text(join(ROOT, 'app/index.html'));
if (!/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*default-src 'none'/.test(html)) {
  problems.push("app/index.html: CSP meta(default-src 'none') 없음");
}
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push('app/index.html: 인라인 script 금지');
const vendorMd = text(join(ROOT, 'VENDOR.md'));
for (const m of html.matchAll(/<script[^>]*src="(vendor\/[^"]+)"[^>]*>/g)) {
  const tag = m[0];
  const src = m[1];
  const sri = /integrity="(sha384-[^"]+)"/.exec(tag)?.[1];
  if (!sri) {
    problems.push(`app/index.html: ${src} 에 integrity 없음`);
    continue;
  }
  const actual = 'sha384-' + createHash('sha384').update(readFileSync(join(ROOT, 'app', src))).digest('base64');
  if (actual !== sri) problems.push(`app/index.html: ${src} integrity 불일치`);
  if (!vendorMd.includes(actual)) problems.push(`VENDOR.md: ${src} 해시 기록 없음`);
}

// 6. 서버 함수의 외부 호출은 허용 목록(_shared/http.ts)으로만 — 규칙은 scripts/net-rules.mjs(단위 시험 있음)
for (const p of all) for (const v of netViolations(rel(p), text(p))) problems.push(v);

// 5. config.js: URL 은 https://<ref>.supabase.co, 키는 publishable(sb_publishable_…) 또는 'TODO' 만
const cfg = text(join(ROOT, 'app/config.js'));
const cfgUrl = /SUPABASE_URL\s*=\s*'([^']*)'/.exec(cfg)?.[1];
const cfgKey = /SUPABASE_PUBLISHABLE_KEY\s*=\s*'([^']*)'/.exec(cfg)?.[1];
if (!(cfgUrl === 'TODO' || /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(cfgUrl ?? ''))) problems.push('app/config.js: SUPABASE_URL 형식');
if (!(cfgKey === 'TODO' || /^sb_publishable_[A-Za-z0-9_-]+$/.test(cfgKey ?? ''))) problems.push('app/config.js: publishable 키만 허용(sb_publishable_…)');
if (cfgUrl && cfgUrl !== 'TODO' && !html.includes(`connect-src 'self' ${cfgUrl};`)) {
  problems.push('app/index.html: CSP connect-src 가 config.js 의 SUPABASE_URL 과 다름');
}

if (problems.length) {
  console.error(`보안 검사 실패 ${problems.length}건`);
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(`보안 검사 통과 (코드 ${codeFiles.length}개, 앱 ${appFiles.length}개, 전체 ${all.length}개 파일)`);
