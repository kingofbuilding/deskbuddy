'use strict';

/**
 * 统一的 Electron 启动器。
 *
 * 为什么需要它：
 *  - 有些环境（CI、受限容器、远程会话）里，Chromium 的多进程 IPC 需要
 *    --no-sandbox 才能建立；另外部分虚拟显卡下 GPU 合成会让透明窗口闪黑。
 *  - 直接 `electron .` 在普通 Windows 桌面上工作正常，这里只是让
 *    `npm run smoke` 之类自动化入口更稳，并且能拿到子进程退出码。
 *
 * 用法：
 *   node scripts/run-electron.js . --smoke
 *   node scripts/run-electron.js . --restart-test=write
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function electronExe() {
  const candidate = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(candidate)) return candidate;
  // 非 Windows 或已安装为 node 模块时用官方入口
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (_) {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const exe = electronExe();
  if (!exe) {
    console.error('找不到 Electron，请先运行 npm install');
    process.exit(2);
  }

  const extra = [];
  const automated = args.some(
    (a) => a === '--smoke' || a.indexOf('-test') >= 0 || a.indexOf('--restart') >= 0
  );

  // 自动化场景：避开受限环境下 Chromium 多进程 IPC 的限制，并使用独立的数据目录，
  // 避免测试数据污染真实的用户数据。
  if (automated) {
    extra.push('--no-sandbox', '--disable-gpu');
    if (!args.some((a) => a.startsWith('--user-data-dir'))) {
      const dataDir = path.join(ROOT, '.tmp', 'e2e-data');
      fs.mkdirSync(dataDir, { recursive: true });
      extra.push('--user-data-dir=' + dataDir);
    }
  }
  if (process.env.DESKBUDDY_NO_SANDBOX === '1' && !automated) extra.push('--no-sandbox');
  if (process.env.DESKBUDDY_DISABLE_GPU === '1' && !automated) extra.push('--disable-gpu');

  const tmp = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const stamp = Date.now();
  const outFile = path.join(tmp, 'electron-' + stamp + '.out.txt');
  const errFile = path.join(tmp, 'electron-' + stamp + '.err.txt');
  const batFile = path.join(tmp, 'electron-' + stamp + '.bat');

  // 用批处理启动，避开 PowerShell/cmd 的引号陷阱，并清掉可能残留的环境变量
  const command = ['"' + exe + '"', '"' + path.resolve(ROOT, args[0] || '.') + '"']
    .concat(args.slice(1))
    .concat(extra)
    .join(' ');

  fs.writeFileSync(
    batFile,
    [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE="',
      '@chcp 65001 >nul',
      'cd /d "' + ROOT + '"',
      command + ' > "' + outFile + '" 2> "' + errFile + '"'
    ].join('\r\n'),
    'ascii'
  );

  const result = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', batFile], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 180000
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

  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);

  process.exit(result.status === null ? 1 : result.status);
}

main();
