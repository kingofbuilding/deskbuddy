'use strict';

/**
 * Preload：渲染进程唯一能接触到的桌面能力。
 *
 * 安全约束（需求 4.4）：
 *  - 只暴露这里显式列出的函数，不暴露 ipcRenderer 本体。
 *  - 不提供任意文件路径读写、不提供 shell 执行、不提供 exec/spawn。
 *  - 所有参数在主进程再次校验，渲染进程拿到的返回值都是纯数据。
 */

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

/** 主进程推送到渲染进程时允许的通道白名单 */
const ALLOWED_MESSAGE_CHANNELS = ['pet:state', 'pet:bubble', 'pet:pointer', 'app:action', 'app:snapshot'];

const api = {
  /** 运行环境信息（只读，用于界面显示与诊断） */
  getInfo: () => invoke('app:info'),

  /** 一次性读取任务 / 设置 / 计时快照 */
  loadState: () => invoke('data:load'),

  /** 三个独立保存入口，避免一次失败影响全部数据 */
  saveTasks: (tasks) => invoke('data:save-tasks', tasks),
  saveSettings: (settings) => invoke('data:save-settings', settings),
  saveSession: (session) => invoke('data:save-session', session),

  /** 窗口控制 */
  window: {
    beginDrag: () => invoke('window:drag-start'),
    dragTo: (dx, dy) => invoke('window:drag-move', { dx, dy }),
    endDrag: () => invoke('window:drag-end'),
    getPosition: () => invoke('window:position'),
    setAlwaysOnTop: (on) => invoke('window:always-on-top', Boolean(on)),
    setScale: (scale) => invoke('window:set-scale', scale),
    openPanel: (kind) => invoke('window:open-panel', kind),
    closePanel: (kind) => invoke('window:close-panel', kind),
    hidePet: () => invoke('window:hide-pet'),
    showPet: () => invoke('window:show-pet'),
    quit: () => invoke('app:quit'),
    setBadge: (text) => invoke('window:set-badge', text)
    , visit: (kind,holder) => invoke('window:pet-visit', {kind,holder:holder||''})
    , returnHome: () => invoke('window:pet-return')
    , recover: () => invoke('window:recover-pet')
    , setInteractive: (on) => ipcRenderer.send('window:pet-interactive', Boolean(on))
    , setPopupVisible: (on) => ipcRenderer.send('window:pet-popup', Boolean(on))
  },

  /** 数据目录（仅打开固定目录，不接受任意路径） */
  openDataFolder: () => invoke('app:open-data-folder'),

  /** 面板窗口：取当前状态快照、把用户操作转交给宠物窗口执行 */
  getSnapshot: () => invoke('app:get-snapshot'),
  dispatch: (action) => invoke('app:dispatch', action),
  broadcastState: (snapshot) => invoke('app:broadcast-state', snapshot),

  /** 收窄快照，只保留界面需要的字段，避免内部结构跨进程传递 */
  toSnapshot: (state) => {
    if (!state || typeof state !== 'object') return null;
    return {
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
      stats: state.stats || null,
      settings: state.settings || null,
      timers: state.timers || null,
      pet: state.pet || null,
      ui: state.ui || null
    };
  },

  /** 请求播放全屏特效（覆盖层） */
  fullscreenFx: (name, holder, kind, frame) => invoke('app:fullscreen-fx', { name, holder, kind, frame }),
  actorAnchor: (frame) => ipcRenderer.send('app:actor-anchor', frame),
  entertainmentAction: (command) => invoke('activity:window-action', command),

  /** 监听主进程推送 */
  onMainMessage: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => {
      if (!payload || ALLOWED_MESSAGE_CHANNELS.indexOf(payload.channel) < 0) return;
      handler(payload);
    };
    ipcRenderer.on('main:message', listener);
    return () => ipcRenderer.removeListener('main:message', listener);
  }
};

contextBridge.exposeInMainWorld('deskbuddy', api);
