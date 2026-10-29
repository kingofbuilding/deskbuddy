'use strict';
const {waitForReady,sleep}=require('../src/main/selftest.js');
async function run({app,petWindow,getFxWindow}){
 const js=source=>petWindow.webContents.executeJavaScript(source);
 const record=(name,ok,detail)=>{console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));if(!ok)throw Error(name);};
 const until=async(predicate,timeout=5000)=>{for(let n=0;n<timeout/100;n++){if(await predicate())return true;await sleep(100);}return false;};
 try{
  record('界面就绪',await waitForReady(petWindow,15000));
  await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{chatterEnabled:false,lifeEnabled:true,wanderEnabled:true,healthRemindersEnabled:false,gameGuardEnabled:true,guardEffectsEnabled:true,gameGraceMinutes:1,guardCooldownMinutes:15,doNotDisturb:false}});window.__deskbuddyDispatch({type:'tasks/add',title:'自动演出测试任务'});window.__deskbuddyDispatch({type:'bubble/dismiss'});window.__originalPet=document.getElementById('pet');window.__testClock=Date.now();true`);
  const sample=async offset=>js(`(()=>{for(let t=0;t<=65000;t+=5000)window.__deskbuddyDispatch({type:'activity/sample',now:window.__testClock+${offset}+t,idleSeconds:600,matchedApp:'vlc.exe',desktopActive:true});return true;})()`);
  await sample(0);
  record('长时间看视频无键鼠操作也会提醒',await js(`window.__deskbuddySnapshot().bubble==='task_nudge'`));
  record('走到面前后自动挥刀',await until(()=>js(`document.getElementById('pet').dataset.performance==='slash'`)));
  const fx=getFxWindow();record('实际全屏砍刀层已播放',!!fx&&await fx.webContents.executeJavaScript(`document.body.dataset.active==='slash'||document.documentElement.dataset.active==='slash'||document.getElementById('fx-slash').classList.contains('active')`));
  record('挥刀仍是原本桌宠',await js(`window.__originalPet===document.getElementById('pet')`));
  await js(`document.querySelector('[data-action-id="finish_round"]').click();true`);await sleep(1350);
  record('这局打完会中断自动演出',!(await js(`Boolean(document.getElementById('pet').dataset.performance)`))&&!fx.isVisible());
  await sample(17*60000);
  record('冷却后下一次自动裂屏',await until(()=>js(`document.getElementById('pet').dataset.performance==='crack'`)));
  await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{doNotDisturb:true}});true`);await sleep(120);
  record('免打扰立即停止裂屏并保留任务',!(await js(`Boolean(document.getElementById('pet').dataset.performance)`))&&!fx.isVisible()&&await js(`window.__deskbuddySnapshot().completed===0`));
  await sleep(1250);
  await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{doNotDisturb:false,gameGuardEnabled:false}});window.__deskbuddyDispatch({type:'activity/sample',now:Date.now(),idleSeconds:90,matchedApp:'',desktopActive:true});true`);
  await sleep(150);
  const home=petWindow.getBounds();
  const wander=await js(`window.deskbuddy.window.visit('wander')`);record('空闲时可以开始全桌面游走',wander.ok,wander);
  await sleep(1300);const moved=petWindow.getBounds();
  record('鱼鱼实际在桌面移动并切换走路帧',Math.hypot(moved.x-home.x,moved.y-home.y)>20&&await js(`document.getElementById('pet').dataset.life==='walk'`),{home,moved});
  await js(`window.__deskbuddyDispatch({type:'focus/start',minutes:25});true`);await sleep(1450);
  const back=petWindow.getBounds();record('开始专注会中断散步并回家',back.x===home.x&&back.y===home.y,{home,back});
  await js(`window.__deskbuddyDispatch({type:'focus/stop'});window.__deskbuddyDispatch({type:'bubble/dismiss'});window.__deskbuddyDispatch({type:'tasks/add',title:'还有一个任务'});true`);
  await js(`window.deskbuddy.window.openPanel('tasks')`);await sleep(500);
  // 通过真实任务面板完成第一项，保留另一项，验证每完成一项也会撒花。
  const {BrowserWindow}=require('electron');const panel=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('panel=tasks'));
  await panel.webContents.executeJavaScript(`document.querySelector('[data-task-toggle]').click();true`);await sleep(150);
  record('完成单项任务立即撒花',await js(`document.getElementById('pet').dataset.performance==='confetti'&&window.__deskbuddySnapshot().completed===1`));
  console.log('PHASE_RESULT=PASS');app.exit(0);
 }catch(error){console.error(error.stack);console.log('PHASE_RESULT=FAIL');app.exit(1);}
}
module.exports={run};
