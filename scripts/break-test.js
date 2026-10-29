'use strict';

/**
 * 休息提醒验证：node scripts/break-test.js
 * 启动一次真实 Electron 进程，跑完 break-phase 里的检查。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp');

function electronExe() {
  const candidate = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(candidate) ? candidate : process.execPath;
}

fs.mkdirSync(TMP, { recursive: true });
const dataDir = path.join(TMP, 'break-' + Date.now());
fs.mkdirSync(dataDir, { recursive: true });

const outFile = path.join(TMP, 'break.out.txt');
const errFile = path.join(TMP, 'break.err.txt');
const batFile = path.join(TMP, 'break.bat');

fs.writeFileSync(
  batFile,
  [
    '@echo off',
    'set "ELECTRON_RUN_AS_NODE="',
    '@chcp 65001 >nul',
    'cd /d "' + ROOT + '"',
    '"' + electronExe() + '" "' + ROOT + '" --break-test --user-data-dir="' + dataDir +
      '" --no-sandbox --disable-gpu > "' + outFile + '" 2> "' + errFile + '"'
  ].join('\r\n'),
  'ascii'
);

const result = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', batFile], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000
});

let stdout = '';
let stderr = '';
try {
  stdout = fs.readFileSync(outFile, 'utf8');
} catch (_) {
  stdout = '';
}
try {
  stderr = fs.readFileSync(errFile, 'utf8');
} catch (_) {
  stderr = '';
}

const ok = /PHASE_RESULT=PASS/.test(stdout);
console.log('BREAK_RESULT=' + (ok ? 'PASS' : 'FAIL'));
console.log(stdout.trim());
if (stderr.trim()) console.log('[stderr]\n' + stderr.split('\n').slice(-10).join('\n'));
process.exit(ok ? 0 : 1);
