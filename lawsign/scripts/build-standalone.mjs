#!/usr/bin/env node
/**
 * 로싸인(LawSign) 단일 파일 배포본 빌더
 *
 * 일부 렌더링 환경(샌드박스 뷰어, HTML 새니타이저)은 본문의 <style> 태그를
 * 제거해 스크립트만 실행되고 디자인이 전부 소실된다. 이를 방지하기 위해
 * CSS를 JS 문자열로 내장하고 부팅 시 document.head에 주입한다 —
 * 스크립트가 실행되는 모든 환경에서 스타일이 보장된다.
 *
 * 사용법:
 *   node lawsign/scripts/build-standalone.mjs                 # frontend/lawsign-standalone.html 생성
 *   node lawsign/scripts/build-standalone.mjs --fragment OUT  # 문서 래퍼 없는 조각(HTML 뷰어 삽입용)도 생성
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const read = (p) => readFile(path.join(FRONTEND, p), 'utf8');

const css = await read('css/app.css');
const js = [await read('js/api.js'), await read('js/app.js'), await read('js/request.js')].join('\n');

if (css.includes('</script') || js.includes('</script')) {
  throw new Error('소스에 "</script" 시퀀스가 포함되어 인라인 삽입이 불가합니다.');
}

const bodyContent =
  '<noscript>로싸인 프로토타입은 JavaScript가 필요합니다.</noscript>\n' +
  '<script>\n' +
  '// CSS를 JS에서 주입 — <style> 태그를 제거하는 뷰어에서도 디자인 유지\n' +
  '(function () {\n' +
  '  var s = document.createElement("style");\n' +
  '  s.id = "ls-style";\n' +
  '  s.textContent = ' + JSON.stringify(css) + ';\n' +
  '  (document.head || document.documentElement).appendChild(s);\n' +
  '})();\n' +
  js +
  '\n</script>\n';

const standalone =
  '<!doctype html>\n<html lang="ko">\n<head>\n' +
  '  <meta charset="utf-8" />\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  '  <title>로싸인 LawSign — 법무 특화 전자서명 워크스페이스</title>\n' +
  '</head>\n<body>\n' + bodyContent + '</body>\n</html>\n';

const outMain = path.join(FRONTEND, 'lawsign-standalone.html');
await writeFile(outMain, standalone);
console.log('생성:', outMain, '(' + standalone.length.toLocaleString() + ' bytes)');

const fragIdx = process.argv.indexOf('--fragment');
if (fragIdx > -1 && process.argv[fragIdx + 1]) {
  const frag = '<title>로싸인 LawSign — 프론트엔드 프로토타입</title>\n' + bodyContent;
  await writeFile(process.argv[fragIdx + 1], frag);
  console.log('생성:', process.argv[fragIdx + 1], '(' + frag.length.toLocaleString() + ' bytes)');
}
