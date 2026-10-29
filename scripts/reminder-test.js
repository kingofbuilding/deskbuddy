'use strict';

/**
 * 提醒触发验证（真实 Electron）。
 *
 * 用“过去的时间戳”让专注立即到期，避免真的等 1 分钟：
 *  1. 加任务 -> 开始专注 -> 把结束时间改成 1 秒前 -> tick
 *  2. 断言：专注结束、弹出 focus_done 提醒、宠物进入 reminder
 *  3. 点“我完成了” -> 任务完成、统计+1、进入庆祝
 *
 * 运行：node scripts/reminder-test.js
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

function run() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, 'reminder-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });

  const exe = electronExe();
  const outFile = path.join(TMP, 'reminder.out.txt');
  const errFile = path.join(TMP, 'reminder.err.txt');
  const batFile = path.join(TMP, 'reminder.bat');

  const bat = [
    '@echo off',
    'set "ELECTRON_RUN_AS_NODE="',
    '@chcp 65001 >nul',
    'cd /d "' + ROOT + '"',
    '"' + exe + '" "' + ROOT + '" --reminder-test --user-data-dir="' + dataDir +
      '" --no-sandbox --disable-gpu > "' + outFile + '" 2> "' + errFile + '"'
  ].join('\r\n');
  fs.writeFileSync(batFile, bat, 'ascii');

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
  console.log('REMINDER_RESULT=' + (ok ? 'PASS' : 'FAIL'));
  console.log(stdout.trim());
  if (stderr.trim()) console.log('[stderr]\n' + stderr.split('\n').slice(-10).join('\n'));
  process.exit(ok ? 0 : 1);
}

run();
