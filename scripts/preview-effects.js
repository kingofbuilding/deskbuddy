'use strict';

// 使用真实覆盖层验证第一次播放、各场景渲染、退场和粒子清理，并导出视觉预览。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('../src/main/effects-window.js');
const output = path.join(__dirname, '..', 'docs', 'previews');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const onlyScene = (process.argv.find((arg) => arg.startsWith('--scene=')) || '').slice(8);
app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, '..', '.tmp', 'preview-data'));

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const [name, kind, filename] of [
      ['reminder', 'focus_done', 'effect-reminder'],
      ['reminder', 'break', 'effect-break'],
      ['slash', null, 'effect-slash'],
      ['crack', null, 'effect-crack'],
      ['confetti', null, 'effect-confetti']
    ].filter(([name]) => !onlyScene || name === onlyScene)) {
      fx.play(name, 'preview-' + filename, kind);
      const win = fx.getWindow();
      for (let i = 0; i < 60; i++) {
        if (!win.webContents.isLoading() && await win.webContents.executeJavaScript('!!document.querySelector(".fx-scene.active")').catch(() => false)) break;
        await sleep(50);
      }
      const active = await win.webContents.executeJavaScript('document.body.dataset.fx');
      if (active !== name || !win.isVisible()) throw new Error(filename + ': scene did not start');
      const style = await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, 'preview-desktop.css'), 'utf8'));
      await win.webContents.executeJavaScript(`(function(){
        var desktop = document.createElement('div'); desktop.className='preview-desktop';
        desktop.innerHTML='<div class="preview-window"><div class="preview-titlebar"><span>工作台 · 今日计划</span><span>—　□　×</span></div><div class="preview-layout"><div class="preview-sidebar"><b>今日清单</b><br>项目文件<br>专注记录<br>归档</div><div class="preview-content"><h1>把今天过得从容一点</h1><small>我的工作空间 / 今日</small><div class="preview-card"><span class="preview-check">☑</span>整理项目资料<br><span class="preview-check">☐</span>完成界面设计<br><span class="preview-check">☐</span>检查交互细节</div><small>一步一步，慢慢做好。</small></div></div></div><div class="preview-note"><h2>随手记</h2><p>下午继续完善项目</p><p>记得起身走一走</p><p>给自己留一点休息时间</p></div><div class="preview-dock"><i></i><i></i><i></i><i></i><i></i><i></i></div>';
        document.body.appendChild(desktop);
      })()`);
      const captureDelay = name === 'slash' ? 1250 : 850;
      await sleep(captureDelay);
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(output, filename + '.png'), shot.resize({ width: 1440 }).toPNG());
      if (name === 'slash') {
        const ratio = await win.webContents.executeJavaScript(`document.querySelector('.fx-cleaver').getBoundingClientRect().width / Number(document.documentElement.dataset.actorHeight)`);
        if (ratio < 15) throw new Error('cleaver does not dwarf character: ' + ratio);
        console.log('PASS cleaver/character length ratio: ' + ratio.toFixed(1));
      }
      await win.webContents.executeJavaScript('document.querySelector(".preview-desktop").remove()');
      await win.webContents.removeInsertedCSS(style);
      if (name === 'crack') {
        await sleep(120); // 等待透明窗口合成下一帧，避免 capturePage 读到刚移除的预览背景。
        const transparent = await win.webContents.capturePage();
        const rgba = transparent.toBitmap();
        let clear = 0;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 50) clear++;
        const ratio = clear / (rgba.length / 4);
        if (ratio < .8) throw new Error('glass obscures desktop: transparent ratio=' + ratio);
        fs.writeFileSync(path.join(output, 'effect-crack-transparent.png'), transparent.resize({ width: 1440 }).toPNG());
        console.log('PASS glass transparent pixels: ' + (100 * ratio).toFixed(1) + '%');
      }
      await sleep(fx.DURATIONS[name] - captureDelay + 400);
      const remaining = await win.webContents.executeJavaScript('document.querySelectorAll(".fx-scene.active, .fx-particle, .glass-fracture path").length');
      if (remaining !== 0 || win.isVisible()) throw new Error(filename + ': scene was not cleaned up');
      console.log('PASS ' + filename + ': started, rendered, captured, cleaned, hidden');
    }
    fx.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    fx.destroy();
    app.exit(1);
  }
});
