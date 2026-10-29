'use strict';

/**
 * 重启恢复验证：用真实 Electron 跑两个独立进程。
 *
 * 场景：第一次启动创建任务并开启专注（1 分钟）后立即退出；
 *       第二次启动检查任务是否还在、专注是否按剩余时间恢复。
 *
 * 用普通 Node 运行：node scripts/restart-test.js
 * （子进程输出重定向到文件，避免依赖管道）
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

function runPhase(phase, dataDir) {
  const exe = electronExe();
  const outFile = path.join(TMP, 'restart-' + phase + '.out.txt');
  const errFile = path.join(TMP, 'restart-' + phase + '.err.txt');
  const batFile = path.join(TMP, 'restart-' + phase + '.bat');

  // 用批处理启动：避免命令行引号穿越，同时清掉可能残留的 ELECTRON_RUN_AS_NODE
  const bat = [
    '@echo off',
    'set "ELECTRON_RUN_AS_NODE="',
    '@chcp 65001 >nul',
    'cd /d "' + ROOT + '"',
    '"' + exe + '" "' + ROOT + '" --restart-test=' + phase +
      ' --user-data-dir="' + dataDir + '" --no-sandbox --disable-gpu' +
      ' > "' + outFile + '" 2> "' + errFile + '"'
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

  return { status: result.status, stdout, stderr };
}

function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, 'restart-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });

  const report = { dataDir, phases: [], ok: false };

  const first = runPhase('write', dataDir);
  report.phases.push({ phase: 'write', ...first });

  const second = runPhase('verify', dataDir);
  report.phases.push({ phase: 'verify', ...second });

  report.ok =
    /PHASE_RESULT=PASS/.test(first.stdout) && /PHASE_RESULT=PASS/.test(second.stdout);

  const outPath = path.join(TMP, 'restart-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('RESTART_REPORT_PATH=' + outPath);
  console.log('RESTART_RESULT=' + (report.ok ? 'PASS' : 'FAIL'));
  for (const phase of report.phases) {
    console.log('\n--- ' + phase.phase + ' (exit ' + phase.status + ') ---');
    console.log(phase.stdout.trim());
    if (phase.stderr.trim()) {
      console.log('[stderr]\n' + phase.stderr.split('\n').slice(-10).join('\n'));
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main();
