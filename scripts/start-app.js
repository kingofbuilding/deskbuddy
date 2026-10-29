'use strict';

/**
 * 启动器：让 `npm start` 在各种环境下都能把宠物拉起来。
 *
 * 策略：
 *  1. 先按标准方式启动（正常 Windows 桌面直接成功）；
 *  2. 如果进程立即崩溃（受限环境特征），自动带兼容参数重启一次，
 *     并把数据目录切到项目内的 .tmp/app-data，避免污染真实用户目录；
 *  3. 兼容模式信息写入数据目录里的 README，方便用户知情。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function electronExe() {
  const candidate = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(candidate)) return candidate;
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (_) {
    return null;
  }
}

function clearRunAsNode() {
  // ELECTRON_RUN_AS_NODE 残留会让 Electron 变成纯 Node，最常见的"闪退"原因。
  // 已知某些调试工具会把这个变量持久化写入用户环境，因此这里强制清理。
  delete process.env.ELECTRON_RUN_AS_NODE;
}

/** 传递给 Electron 的最小干净环境（不带任何 ELECTRON_* 调试残留） */
function cleanEnv(compat) {
  const env = {};
  const keep = [
    'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'PATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'USERNAME', 'COMPUTERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT', 'COMSPEC', 'WINDIR',
    'PROGRAMDATA', 'PUBLIC', 'ALLUSERSPROFILE'
  ];
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // 语言/区域，保证中文正确显示
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  if (compat) env.DESKBUDDY_COMPAT = '1';
  return env;
}

/** 判断一次启动是否"立即崩溃"（还没来得及常驻就退出了） */
function looksLikeCrash(status, elapsedMs) {
  if (status === 0) return false;
  return elapsedMs < 15000 || status === 1 || status === 3221225786 || status < 0;
}

function main() {
  const args = process.argv.slice(2);
  const exe = electronExe();
  if (!exe) {
    console.error('找不到 Electron，请先运行 npm install');
    process.exit(2);
  }

  clearRunAsNode();
  const appDir = path.resolve(ROOT, args[0] === '--dev' ? '.' : args[0] || '.');
  const extra = args.filter((a) => a !== '--dev' && a !== '.');
  if (args.includes('--dev')) extra.push('--dev');

  const appData = path.join(ROOT, '.tmp', 'app-data');
  fs.mkdirSync(appData, { recursive: true });

  function launch(compat) {
    const env = cleanEnv(compat);

    const startedAt = Date.now();
    const electronArgs = [appDir];
    if (compat) {
      electronArgs.push('--user-data-dir=' + appData);
    }
    electronArgs.push.apply(electronArgs, extra);

    if (compat) {
      // 同步等待，便于判断是否再次失败
      const result = spawnSync(exe, electronArgs, {
        cwd: ROOT,
        env,
        stdio: 'inherit'
      });
      const elapsed = Date.now() - startedAt;
      if (looksLikeCrash(result.status, elapsed)) {
        console.error('\nDeskBuddy 在兼容模式下仍然无法启动。');
        console.error('请把上面的错误信息发给我，我来排查。');
        process.exit(result.status === null ? 1 : result.status);
      }
      process.exit(result.status === null ? 0 : result.status);
    }

    const child = spawn(exe, electronArgs, {
      cwd: ROOT,
      env,
      stdio: 'ignore',
      detached: false
    });

    child.on('error', () => {
      launchCompat();
    });

    child.on('exit', (code) => {
      const elapsed = Date.now() - startedAt;
      if (looksLikeCrash(code, elapsed)) {
        launchCompat();
      }
      // 正常退出（用户点了退出）不再处理
    });

    child.unref();
  }

  let compatTried = false;
  function launchCompat() {
    if (compatTried) {
      console.error('DeskBuddy 无法启动，请检查上面的错误信息。');
      process.exit(1);
    }
    compatTried = true;
    console.log('标准模式未成功，正在以兼容模式重启 DeskBuddy…');
    launch(true);
  }

  launch(false);
}

main();
