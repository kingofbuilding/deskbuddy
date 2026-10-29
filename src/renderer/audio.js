/**
 * 音效：用 WebAudio 现场合成，不依赖外部音频文件。
 * 这样仓库里不需要放二进制音频，也不会因为缺文件而静默失败。
 *
 * 约束（需求 6.2）：
 *  - 免打扰 / 关闭音效时不发声。
 *  - 用户主动交互可以在免打扰下显示，但音效一律受 soundEnabled 控制。
 */
(function (global) {
  'use strict';

  const CUES = {
    // 名称: [频率序列, 每音时长, 波形, 峰值音量]
    start: { notes: [523.25, 659.25, 783.99], step: 0.09, type: 'triangle', gain: 0.16 },
    'focus-done': { notes: [783.99, 659.25, 523.25, 659.25], step: 0.14, type: 'sine', gain: 0.2 },
    break: { notes: [587.33, 440, 587.33], step: 0.16, type: 'sine', gain: 0.18 },
    pop: { notes: [880, 1174.66], step: 0.07, type: 'triangle', gain: 0.14 },
    ok: { notes: [659.25, 880], step: 0.1, type: 'sine', gain: 0.14 },
    celebrate: { notes: [523.25, 659.25, 783.99, 1046.5, 1318.51], step: 0.11, type: 'triangle', gain: 0.17 },
    slash: { notes: [1200, 300, 180], step: 0.06, type: 'sawtooth', gain: 0.13 },
    crack: { notes: [160, 110, 90], step: 0.1, type: 'square', gain: 0.12 },
    soft: { notes: [440, 554.37], step: 0.12, type: 'sine', gain: 0.1 }
  };

  function createAudio(options) {
    const opts = options || {};
    let ctx = null;
    let enabled = opts.enabled !== false;
    let unlocked = false;

    function ensureContext() {
      if (ctx) return ctx;
      const Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return null;
      try {
        ctx = new Ctor();
      } catch (_) {
        ctx = null;
      }
      return ctx;
    }

    /** 浏览器要求用户交互后才能播放，这里做一次解锁 */
    function unlock() {
      const context = ensureContext();
      if (!context) return false;
      if (context.state === 'suspended') {
        context.resume().catch(() => {});
      }
      unlocked = true;
      return true;
    }

    /**
     * 播放一个提示音。
     * @returns {boolean} 是否真的排入了播放
     */
    function play(cue) {
      if (!enabled) return false;
      const def = CUES[cue];
      if (!def) return false;
      const context = ensureContext();
      if (!context) return false;
      if (context.state === 'suspended') {
        // 还没解锁：尝试恢复，不阻塞调用方
        context.resume().catch(() => {});
      }

      try {
        // 宽频瞬态更接近玻璃脆裂与钢刃挥动，避免旧版方波的游戏提示音。
        if ((cue === 'crack' || cue === 'slash') && context.createBuffer && context.createBiquadFilter) {
          const noise = (delay, duration, level, frequency, filterType) => {
            const start = context.currentTime + delay;
            const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
            const samples = buffer.getChannelData(0);
            for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
            const source = context.createBufferSource();
            const filter = context.createBiquadFilter();
            const gain = context.createGain();
            source.buffer = buffer;
            filter.type = filterType;
            filter.frequency.setValueAtTime(frequency, start);
            filter.frequency.exponentialRampToValueAtTime(Math.max(90, frequency * .25), start + duration);
            gain.gain.setValueAtTime(.0001, start);
            gain.gain.exponentialRampToValueAtTime(level, start + .006);
            gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
            source.connect(filter); filter.connect(gain); gain.connect(context.destination);
            source.start(start); source.stop(start + duration);
          };
          if (cue === 'crack') {
            noise(.01, .075, .18, 3400, 'highpass');
            noise(.055, .14, .12, 5200, 'highpass');
            noise(.16, .36, .07, 7500, 'bandpass');
          } else {
            noise(.12, .35, .05, 500, 'bandpass');
            noise(1.86, .42, .17, 1700, 'bandpass');
            noise(2.18, .14, .11, 180, 'lowpass');
          }
          return true;
        }
        let cursor = context.currentTime + 0.01;
        for (const freq of def.notes) {
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = def.type;
          osc.frequency.setValueAtTime(freq, cursor);
          gain.gain.setValueAtTime(0, cursor);
          gain.gain.linearRampToValueAtTime(def.gain, cursor + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, cursor + def.step * 0.95);
          osc.connect(gain);
          gain.connect(context.destination);
          osc.start(cursor);
          osc.stop(cursor + def.step);
          cursor += def.step;
        }
        return true;
      } catch (_) {
        return false;
      }
    }

    function setEnabled(value) {
      enabled = Boolean(value);
    }

    function isEnabled() {
      return enabled;
    }

    function suspend() {
      if (ctx && ctx.state === 'running') {
        ctx.suspend().catch(() => {});
      }
    }

    function dispose() {
      enabled = false;
      if (ctx) {
        try {
          ctx.close();
        } catch (_) {
          /* 忽略 */
        }
        ctx = null;
      }
    }

    return {
      CUES,
      play,
      unlock,
      setEnabled,
      isEnabled,
      suspend,
      dispose,
      get unlocked() {
        return unlocked;
      }
    };
  }

  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.audio = { createAudio, CUES };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createAudio, CUES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
