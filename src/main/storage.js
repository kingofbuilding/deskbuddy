'use strict';

/**
 * 本地存储层（主进程）。
 *
 * 对应需求第八章：
 *  - 数据放在 app.getPath('userData')，绝不写入安装目录。
 *  - 每个文件带 schema 版本号，解析失败时备份损坏文件并回退默认值，不崩溃。
 *  - 原子写入（临时文件 + rename），避免写一半断电导致文件损坏。
 *  - 写入失败返回错误对象，由界面提示用户，不静默吞掉。
 *  - 只保存任务、设置、计时/统计聚合数据，不记录任何输入、浏览或截图内容。
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

const FILES = {
  tasks: 'tasks.json',
  settings: 'settings.json',
  session: 'session.json'
};

function nowIso() {
  return new Date().toISOString();
}

/** 原子写：先写临时文件并 fsync，再 rename 覆盖 */
function writeJsonAtomic(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.tmp');
  const payload = JSON.stringify(data, null, 2);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, payload, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* 忽略关闭失败 */
      }
    }
  }
  fs.renameSync(tmp, target);
}

/**
 * 读取并解析一个 JSON 文件。
 * @returns {{ok:true, data:any, existed:boolean} | {ok:false, error:string, corrupt:boolean, backupPath?:string, existed:boolean}}
 */
function readJsonFile(target, options) {
  const opts = options || {};
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, error: 'missing', corrupt: false, existed: false };
    }
    return { ok: false, error: String((error && error.message) || error), corrupt: false, existed: true };
  }

  try {
    const data = JSON.parse(raw);
    return { ok: true, data, existed: true };
  } catch (error) {
    let backupPath = null;
    if (opts.backupCorrupt !== false) {
      backupPath = target + '.corrupt-' + Date.now() + '.json';
      try {
        fs.renameSync(target, backupPath);
      } catch (_) {
        backupPath = null;
      }
    }
    return {
      ok: false,
      error: String((error && error.message) || error),
      corrupt: true,
      backupPath,
      existed: true
    };
  }
}

function createStore(options) {
  const opts = options || {};
  const dir = opts.dir;
  if (!dir) throw new Error('createStore 需要 dir');

  const issues = [];
  const paths = {
    tasks: path.join(dir, FILES.tasks),
    settings: path.join(dir, FILES.settings),
    session: path.join(dir, FILES.session)
  };

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function envelope(kind, data) {
    return { version: SCHEMA_VERSION, kind, savedAt: nowIso(), data };
  }

  function unwrap(kind, parsed) {
    if (parsed && typeof parsed === 'object' && parsed.kind === kind && 'data' in parsed) {
      return { data: parsed.data, version: parsed.version };
    }
    // 兼容没有 envelope 的裸数据
    if (parsed && typeof parsed === 'object') return { data: parsed, version: 0 };
    return { data: null, version: -1 };
  }

  function loadOne(kind) {
    const result = readJsonFile(paths[kind]);
    if (!result.ok) {
      if (result.corrupt) {
        issues.push({
          kind,
          level: 'warn',
          message:
            '数据文件损坏，已备份为 ' +
            (result.backupPath ? path.basename(result.backupPath) : '(未备份)') +
            ' 并恢复默认值。'
        });
      } else if (result.existed) {
        issues.push({ kind, level: 'error', message: '无法读取数据文件：' + result.error });
      }
      return null;
    }
    const unwrapped = unwrap(kind, result.data);
    if (unwrapped.version > SCHEMA_VERSION) {
      issues.push({ kind, level: 'warn', message: '数据来自更新版本，已尽量兼容读取。' });
    }
    return unwrapped.data;
  }

  /**
   * 一次性载入全部数据。
   * @returns {{tasks:any, settings:any, session:any, issues:Array}}
   */
  function loadAll() {
    ensureDir();
    const data = {
      tasks: loadOne('tasks'),
      settings: loadOne('settings'),
      session: loadOne('session')
    };
    return { tasks: data.tasks, settings: data.settings, session: data.session, issues: issues.slice() };
  }

  function saveOne(kind, data) {
    try {
      ensureDir();
      writeJsonAtomic(paths[kind], envelope(kind, data));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function saveAll(data) {
    const out = { ok: true, errors: [] };
    for (const kind of Object.keys(FILES)) {
      if (data && Object.prototype.hasOwnProperty.call(data, kind)) {
        const result = saveOne(kind, data[kind]);
        if (!result.ok) {
          out.ok = false;
          out.errors.push({ kind, error: result.error });
        }
      }
    }
    return out;
  }

  function info() {
    return {
      dir,
      files: Object.assign({}, paths),
      schemaVersion: SCHEMA_VERSION
    };
  }

  function takeIssues() {
    const copy = issues.slice();
    issues.length = 0;
    return copy;
  }

  return {
    dir,
    paths,
    SCHEMA_VERSION,
    loadAll,
    saveOne,
    saveAll,
    info,
    takeIssues,
    ensureDir
  };
}

module.exports = {
  SCHEMA_VERSION,
  FILES,
  createStore,
  readJsonFile,
  writeJsonAtomic
};
