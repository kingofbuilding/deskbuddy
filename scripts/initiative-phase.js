'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { waitForReady, sleep } = require('../src/main/selftest.js');
async function run({ app, petWindow, openPanel, panels }) {
  const record = (name, ok, detail) => {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ': ' + JSON.stringify(detail) : ''));
    if (!ok) throw new Error(name);
  };
  const js = (source) => petWindow.webContents.executeJavaScript(source);
  const output = path.join(__dirname, '..', 'docs', 'previews');
  try {
    record('界面就绪', await waitForReady(petWindow, 15000));
    fs.mkdirSync(output, {recursive:true});
    await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{chatterEnabled:false,lifeEnabled:true,wanderEnabled:false,healthRemindersEnabled:true,waterReminderMinutes:5,breakRemindersEnabled:false,gameGuardEnabled:false}});window.__deskbuddyDispatch({type:'bubble/dismiss'});true`);
    await js(`window.__deskbuddyLifePreview('blink');true`);
    await sleep(45);
    record('闭眼帧真的切换', await js(`document.getElementById('pet').dataset.life === 'blink' && !document.getElementById('pet-life-frame').hidden`));
    await sleep(180);
    record('眨眼结束恢复',await js(`document.getElementById('pet').dataset.life !== 'blink'`));
    const home = petWindow.getPosition();
    await js(`(function(){var start=Date.now();for(var t=0;t<=300000;t+=5000)window.__deskbuddyDispatch({type:'activity/sample',now:start+t,idleSeconds:0,matchedApp:''});return true;})()`);
    await sleep(350);
    const walking = await js(`({state:document.getElementById('pet').dataset.life,src:document.getElementById('pet-life-frame').getAttribute('src')})`);
    record('递水来访使用走路帧', walking.state==='walk' && /walk_/.test(walking.src),walking);
    await sleep(1100);
    record('累计使用到点出现喝水提醒',await js(`window.__deskbuddySnapshot().bubble === 'water'`));
    await js(`document.getElementById('toast-host').textContent='';true`);
    const waterShot = await petWindow.webContents.capturePage(); fs.writeFileSync(path.join(output,'initiative-water.png'),waterShot.toPNG());
    await js(`document.querySelector('[data-action-id="drink"]').click();true`);
    await sleep(1350);
    const returned = petWindow.getPosition();
    record('喝过后退回原位',Math.abs(home[0]-returned[0])<2 && Math.abs(home[1]-returned[1])<2,{home,returned});
    await js(`window.__deskbuddyDispatch({type:'tasks/add',title:'完成实验报告'});window.__deskbuddyDispatch({type:'bubble/dismiss'});window.__deskbuddyDispatch({type:'settings/update',patch:{healthRemindersEnabled:false,gameGuardEnabled:true,gameGraceMinutes:1,guardMode:'visit'}});true`);
    await js(`(function(){var start=Date.now()+20*60000;for(var t=0;t<=65000;t+=5000)window.__deskbuddyDispatch({type:'activity/sample',now:start+t,idleSeconds:0,matchedApp:'cs2.exe'});return true;})()`);
    await sleep(1500);
    record('未完成任务时出现娱乐督促',await js(`window.__deskbuddySnapshot().bubble === 'task_nudge'`));
    const centre = petWindow.getBounds();
    record('宠物走到了屏幕前',Math.abs(centre.x-home[0])>50 || Math.abs(centre.y-home[1])>50,centre);
    const bubbleFits=await js(`(function(){var r=document.getElementById('bubble').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;})()`);
    record('督促操作按钮没有被裁掉',bubbleFits);
    const guardShot=await petWindow.webContents.capturePage();fs.writeFileSync(path.join(output,'initiative-guard.png'),guardShot.toPNG());
    await js(`document.querySelector('[data-action-id="finish_round"]').click();true`);
    await sleep(1350);
    record('这局打完后退回并关闭提醒',await js(`window.__deskbuddySnapshot().bubble === null`));
    await js(`window.__deskbuddyDispatch({type:'initiative/demo',kind:'water'});window.__deskbuddyDispatch({type:'settings/update',patch:{doNotDisturb:true}});true`);
    record('免打扰中止主动互动',await js(`window.__deskbuddySnapshot().bubble === null && window.__deskbuddySnapshot().pet === 'do_not_disturb'`));
    await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{doNotDisturb:false}});true`);
    const panel=openPanel('settings');record('设置面板可打开',panel.ok);
    const win=panels.get('settings');await waitForReady(win,10000);await sleep(300);
    record('主动性开关与应用列表已显示',await win.webContents.executeJavaScript(`!!document.getElementById('game-guard-setting') && !!document.getElementById('entertainment-apps')`));
    // 只操作本测试新建的空窗口，验证原生最小化与正常 WM_CLOSE，绝不碰用户窗口。
    const { BrowserWindow }=require('electron');
    const fixture=new BrowserWindow({width:200,height:100,show:false,skipTaskbar:true});
    fixture.showInactive();
    const native=require('../src/main/windows-activity.js').createWindowsActivity();
    try {
      const target={handle:fixture.getNativeWindowHandle().readBigUInt64LE(0).toString(),processId:process.pid,expected:path.basename(process.execPath).toLowerCase()};
      const mismatch=await native.operate('minimize',{...target,processId:process.pid+1});
      record('原生窗口操作拒绝变化的目标',mismatch.ok===false && mismatch.error === 'target_changed',mismatch);
      const minimized=await native.operate('minimize',target);await sleep(120);
      record('可恢复最小化工作正常',minimized.ok && fixture.isMinimized(),{reply:minimized,minimized:fixture.isMinimized()});
      const closed=await native.operate('close',target);await sleep(180);
      record('正常关闭请求工作正常',closed.ok && fixture.isDestroyed());
    } finally {native.stop();if(!fixture.isDestroyed())fixture.destroy();}
    console.log('PHASE_RESULT=PASS'); app.exit(0);
  } catch(error) { console.error(error.stack);console.log('PHASE_RESULT=FAIL');app.exit(1); }
}
module.exports={run};
