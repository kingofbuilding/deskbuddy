'use strict';

/**
 * 全屏特效覆盖层的 preload。
 * 只暴露两个函数，没有任何文件或系统能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskbuddyOverlay', {
  /** 注册播放监听 */
  onPlay: (handler) => {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('overlay:play', (_event, payload) => handler(payload));
  },
  onAnchor: (handler) => {
    if (typeof handler === 'function') ipcRenderer.on('overlay:anchor', (_event, payload) => handler(payload));
  },
  /** 通知主进程页面已就绪 */
  ready: () => {
    ipcRenderer.send('overlay:ready');
  }
});
