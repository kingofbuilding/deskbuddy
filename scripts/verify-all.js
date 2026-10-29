'use strict';

/**
 * 一键验收：把单元测试、渲染层测试、真实 Electron 冒烟与三条端到端流程全部跑一遍，
 * 输出一份可存档的验收报告（docs/acceptance-report.md + .tmp/verify-report.json）。
 *
 * 用法：
 *   npm run verify            跑全部
 *   npm run test:e2e          只跑 Electron 端到端部分
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp');
const DOCS = path.join(ROOT, 'docs');

const E2E_ONLY = process.argv.includes('--e2e-only');

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });

function runStep(name, command, args, options) {
  const opts = options || {};
  const label = name;
  process.stdout.write('\n=== ' + label + ' ===\n');
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 300000
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const ok = result.status === 0;

  // 只打印尾部，避免刷屏
  const tail = stdout.trim().split('\n').slice(-(opts.tail || 30)).join('\n');
  if (tail) process.stdout.write(tail + '\n');
  if (stderr.trim()) process.stdout.write('[stderr] ' + stderr.trim().split('\n').slice(-6).join('\n') + '\n');
  process.stdout.write((ok ? '=> PASS' : '=> FAIL (exit ' + result.status + ')') + '\n');

  return { name, ok, stdout, stderr, summary: parseSummary(stdout) };
}

/** 从测试输出里提取通过/失败数 */
function parseSummary(stdout) {
  const tests = /^# tests (\d+)/m.exec(stdout);
  const pass = /^# pass (\d+)/m.exec(stdout);
  const fail = /^# fail (\d+)/m.exec(stdout);
  if (tests && pass && fail) {
    return { tests: Number(tests[1]), passed: Number(pass[1]), failed: Number(fail[1]) };
  }
  const phasePass = /PHASE_RESULT=PASS/.test(stdout);
  if (phasePass) return { tests: null, passed: null, failed: 0 };
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function main() {
  const startedAt = new Date();
  const steps = [];

  if (!E2E_ONLY) {
    steps.push(
      runStep('单元测试（核心逻辑）', process.execPath, [
        '--test',
        '--test-timeout=30000',
        'test/core.test.js',
        'test/timers.test.js',
        'test/pet-state.test.js',
        'test/app-state.test.js',
        'test/initiative.test.js'
      ])
    );

    steps.push(
      runStep('集成测试（真实 DOM）', process.execPath, [
        '--test',
        '--test-timeout=30000',
        'test/renderer.test.js',
        'test/overlay.test.js'
      ])
    );
  }

  steps.push(runStep('应用自检（真实 Electron 窗口）', process.execPath, ['scripts/run-electron.js', '.', '--smoke']));
  steps.push(runStep('端到端：重启后恢复任务与计时', process.execPath, ['scripts/restart-test.js']));
  steps.push(runStep('端到端：专注结束提醒与任务确认', process.execPath, ['scripts/reminder-test.js']));
  steps.push(runStep('端到端：休息提醒与防轰炸', process.execPath, ['scripts/break-test.js']));
  steps.push(runStep('端到端：日常动作、主动递水与任务督促', process.execPath, ['scripts/run-electron.js', '.', '--initiative-test', '--user-data-dir=' + path.join(TMP, 'initiative-' + Date.now())]));
  steps.push(runStep('全屏漫画特效：五场演出与清理截图', process.execPath, ['scripts/run-electron.js', 'scripts/preview-effects.js', '--preview-test']));
  steps.push(runStep('端到端：透明本体、特效联动与任务栏找回', process.execPath, ['scripts/run-electron.js', '.', '--actor-test', '--user-data-dir=' + path.join(TMP, 'actor-' + Date.now())]));
  steps.push(runStep('端到端：贴边拖动、菜单退场与独立任务栏入口', process.execPath, ['scripts/run-electron.js', '.', '--usability-test', '--user-data-dir=' + path.join(TMP, 'usability-' + Date.now())]));
  steps.push(runStep('端到端：自动砍刀裂屏、全桌面游走与完成撒花', process.execPath, ['scripts/run-electron.js', '.', '--autonomy-test', '--user-data-dir=' + path.join(TMP, 'autonomy-' + Date.now())]));

  const smokeReport = readJson(path.join(TMP, 'e2e-data', 'smoke-report.json'));
  const restartReport = readJson(path.join(TMP, 'restart-report.json'));

  const allOk = steps.every((s) => s.ok);
  const finishedAt = new Date();

  const report = {
    project: 'DeskBuddy',
    version: '1.0.0',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSeconds: Math.round((finishedAt - startedAt) / 1000),
    platform: process.platform,
    node: process.version,
    electron:
      (smokeReport && smokeReport.electron) ||
      (() => {
        try {
          return require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
        } catch (_) {
          return 'unknown';
        }
      })(),
    ok: allOk,
    steps: steps.map((s) => ({
      name: s.name,
      ok: s.ok,
      summary: s.summary
    })),
    smoke: smokeReport
      ? {
          passed: smokeReport.passed,
          failed: smokeReport.failed,
          results: smokeReport.results
        }
      : null,
    restart: restartReport
      ? {
          ok: restartReport.ok,
          phases: restartReport.phases.map((p) => ({
            phase: p.phase,
            status: p.status,
            lines: p.stdout.split('\n').filter((l) => l.trim())
          }))
        }
      : null
  };

  fs.writeFileSync(path.join(TMP, 'verify-report.json'), JSON.stringify(report, null, 2));
  writeMarkdown(report);

  process.stdout.write('\n========================================\n');
  process.stdout.write('验收结果：' + (allOk ? 'PASS' : 'FAIL') + '\n');
  process.stdout.write('报告：docs/acceptance-report.md\n');
  process.stdout.write('JSON：.tmp/verify-report.json\n');
  for (const step of steps) {
    process.stdout.write((step.ok ? '  ✓ ' : '  ✗ ') + step.name + '\n');
  }

  process.exit(allOk ? 0 : 1);
}

function writeMarkdown(report) {
  const lines = [];
  lines.push('# DeskBuddy 验收报告');
  lines.push('');
  lines.push('> 本文件由 `npm run verify` 自动生成，记录本次实际运行的结果。');
  lines.push('');
  lines.push('| 项目 | 值 |');
  lines.push('|---|---|');
  lines.push('| 运行时间 | ' + report.startedAt + ' |');
  lines.push('| 耗时 | ' + report.durationSeconds + ' 秒 |');
  lines.push('| 平台 | ' + report.platform + ' |');
  lines.push('| Node | ' + report.node + ' |');
  lines.push('| Electron | ' + report.electron + ' |');
  lines.push('| 总体结果 | ' + (report.ok ? '✅ PASS' : '❌ FAIL') + ' |');
  lines.push('');
  lines.push('## 各步骤结果');
  lines.push('');
  lines.push('| 步骤 | 结果 | 用例数 | 通过 | 失败 |');
  lines.push('|---|---|---|---|---|');
  for (const step of report.steps) {
    const s = step.summary || {};
    lines.push(
      '| ' + step.name + ' | ' + (step.ok ? '✅' : '❌') + ' | ' +
        (s.tests === undefined || s.tests === null ? '—' : s.tests) + ' | ' +
        (s.passed === undefined || s.passed === null ? '—' : s.passed) + ' | ' +
        (s.failed === undefined || s.failed === null ? '—' : s.failed) + ' |'
    );
  }
  lines.push('');

  if (report.smoke) {
    lines.push('## 应用自检明细（真实 Electron）');
    lines.push('');
    lines.push('通过 ' + report.smoke.passed + ' 项，失败 ' + report.smoke.failed + ' 项。');
    lines.push('');
    lines.push('| 检查项 | 结果 | 说明 |');
    lines.push('|---|---|---|');
    for (const item of report.smoke.results) {
      lines.push('| ' + item.name + ' | ' + (item.ok ? '✅' : '❌') + ' | ' + escapeCell(item.detail) + ' |');
    }
    lines.push('');
  }

  if (report.restart) {
    lines.push('## 重启恢复');
    lines.push('');
    for (const phase of report.restart.phases) {
      lines.push('### 阶段：' + phase.phase + '（退出码 ' + phase.status + '）');
      lines.push('');
      lines.push('```');
      for (const line of phase.lines) lines.push(line);
      lines.push('```');
      lines.push('');
    }
  }

  fs.writeFileSync(path.join(DOCS, 'acceptance-report.md'), lines.join('\n'), 'utf8');
}

function escapeCell(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

main();
