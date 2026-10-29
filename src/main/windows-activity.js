'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const fs = require('node:fs');

function createWindowsActivity(options) {
  let child = null, reader = null, sequence = 0;
  const requests = new Map();
  function clear(diagnostic) {
    for (const item of requests.values()) { clearTimeout(item.timer); item.resolve({ ok: false, error: 'monitor_unavailable', diagnostic: typeof diagnostic === 'string' ? diagnostic : '' }); }
    requests.clear();
  }
  function ensure() {
    if (child) return;
    const tempDir = options && options.getTempDir ? options.getTempDir() : path.join(__dirname, '..', '..', '.tmp', 'native-runtime');
    fs.mkdirSync(tempDir, { recursive: true });
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-activity.ps1'), '-Daemon'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { TEMP: tempDir, TMP: tempDir })
    });
    const current = child;
    let diagnostic = '';
    current.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-3000); });
    reader = readline.createInterface({ input: current.stdout });
    reader.on('line', (line) => {
      let result;
      try { result = JSON.parse(line); } catch (_) { return; }
      const item = requests.get(result.id);
      if (!item) return;
      clearTimeout(item.timer); requests.delete(result.id); item.resolve(result);
    });
    current.on('error', clear);
    current.stdin.on('error', clear);
    current.on('exit', () => { if (child === current) { child = null; clear(diagnostic); } });
  }
  function request(command, target) {
    if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported_platform' });
    if (!['sample', 'minimize', 'close'].includes(command)) return Promise.resolve({ ok: false, error: 'bad_command' });
    ensure();
    return new Promise((resolve) => {
      const id = ++sequence;
      const timer = setTimeout(() => { requests.delete(id); resolve({ ok: false, error: 'monitor_timeout' }); }, 5000);
      requests.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify(Object.assign({}, target || {}, { id, command })) + '\n');
    });
  }
  function stop() {
    clear();
    if (reader) reader.close();
    reader = null;
    if (child) { child.stdin.end(); child.kill(); }
    child = null;
  }
  return { sample: () => request('sample'), operate: (command, target) => request(command, target), stop };
}
module.exports = { createWindowsActivity };
