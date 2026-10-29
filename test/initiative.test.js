'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const initiative = require('../src/renderer/core/initiative.js');
const settings = require('../src/renderer/core/settings.js');
const app = require('../src/renderer/core/app-state.js');
const MIN = 60000, T0 = new Date(2026,9,29,12).getTime();
const defaults = (patch) => settings.normalizeSettings(Object.assign({waterReminderMinutes:5,breakReminderMinutes:10,gameGraceMinutes:1},patch));
function activity(previous, now, options, sample, context) {
  return initiative.advance(previous,{now,idleSeconds:0,matchedApp:'',...sample},options,{busy:false,pendingCount:1,...context});
}
function runMinutes(minutes, config, sample, context) {
  let state = initiative.create(T0), events=[];
  for(let t=0;t<=minutes*MIN;t+=5000) {
    const result=activity(state,T0+t,config,sample,context);state=result.next;if(result.event)events.push(result.event);
  }
  return {state,events};
}
test('累计实际活动时间到点递水，不靠开机时间误报',()=>{
  const r=runMinutes(5,defaults());
  assert.deepEqual(r.events.map(e=>e.kind),['water']);
  assert.equal(r.state.waterMs,5*MIN);
});
test('离开三分钟重置久坐计时，喝水计时暂停',()=>{
  const config=defaults();
  const r=runMinutes(3,config);
  const away=activity(r.state,T0+4*MIN,config,{idleSeconds:181});
  assert.equal(away.next.workMs,0);assert.equal(away.next.waterMs,r.state.waterMs);assert.equal(away.event,null);
});
test('长时间休眠不补算使用时间，重新开始连续活动计时',()=>{
  const config=defaults();let s=activity(initiative.create(T0),T0,config).next;
  s=activity(s,T0+8*60*MIN,config).next;
  assert.equal(s.workMs,0);assert.equal(s.waterMs,0);
});
test('游戏督促必须有未完成任务、前台娱乐应用并达到宽限时间',()=>{
  const config=defaults({gameGuardEnabled:true,healthRemindersEnabled:false});
  assert.deepEqual(runMinutes(2,config,{matchedApp:'cs2.exe'}).events.map(e=>e.kind),['task_nudge']);
  assert.equal(runMinutes(2,config,{matchedApp:'cs2.exe'},{pendingCount:0}).events.length,0);
  assert.equal(runMinutes(2,config,{matchedApp:''}).events.length,0);
  assert.equal(runMinutes(2,defaults({healthRemindersEnabled:false}),{matchedApp:'cs2.exe'}).events.length,0);
});
test('免打扰、忙碌和冷却都会压住主动催促',()=>{
  assert.equal(runMinutes(6,defaults({doNotDisturb:true})).events.length,0);
  assert.equal(runMinutes(6,defaults(),{},{busy:true}).events.length,0);
  const r=runMinutes(4,defaults({healthRemindersEnabled:false,gameGuardEnabled:true}),{matchedApp:'cs2.exe'});
  assert.equal(r.events.length,1);
});
test('设置对范围和应用名单做校验，自动处理模式只有上前与最小化',()=>{
  const config=defaults({waterReminderMinutes:-1,gameGraceMinutes:999,guardMode:'kill',entertainmentApps:'CS2.EXE\ncs2.exe\nfoo; rm -rf\nchrome.exe\n../evil.exe'});
  assert.equal(config.waterReminderMinutes,5);assert.equal(config.gameGraceMinutes,60);
  assert.equal(config.guardMode,'visit');assert.equal(config.entertainmentApps,'cs2.exe\nchrome.exe');
});
test('喝水确认重新计时，稍后提醒不立即重弹',()=>{
  let s=app.createInitialState({now:T0});s=app.reduce(s,{type:'initiative/demo',kind:'water'}).state;
  s.initiative={...s.initiative,waterMs:30*MIN};
  const done=app.reduce(s,{type:'reminder/action',actionId:'drink'});
  assert.equal(done.state.initiative.waterMs,0);assert.equal(done.state.ui.bubble,null);
  s=app.reduce(done.state,{type:'initiative/demo',kind:'water'}).state;
  const later=app.reduce(s,{type:'reminder/action',actionId:'later'}).state;
  assert.ok(later.initiative.waterUntil>T0);
});
test('游戏提醒选择先做任务会绑定第一条任务并让宠物退回',()=>{
  let s=app.createInitialState({now:T0});s=app.reduce(s,{type:'tasks/add',title:'写实验报告'}).state;
  s=app.reduce(s,{type:'initiative/demo',kind:'task_nudge'}).state;
  const result=app.reduce(s,{type:'reminder/action',actionId:'start_task'});
  assert.equal(result.state.timers.focus.status,'running');assert.equal(result.state.timers.focus.taskId,s.tasks[0].id);
  assert.ok(result.effects.some(e=>e.type==='pet-return'));
});
test('关闭窗口只产生显式操作请求，普通活动永远不产生关闭请求',()=>{
  let s=app.createInitialState({now:T0});s=app.reduce(s,{type:'initiative/demo',kind:'task_nudge'}).state;
  const result=app.reduce(s,{type:'reminder/action',actionId:'close_app'});
  assert.ok(result.effects.some(e=>e.type==='entertainment-close'));
  assert.equal(result.state.ui.bubble.kind,'task_nudge');
  assert.ok(!app.reduce(s,{type:'activity/sample',now:T0+MIN,idleSeconds:0,matchedApp:'cs2.exe'}).effects.some(e=>e.type==='entertainment-close'));
});
test('会话恢复保留喝水/暂缓，清空连续娱乐与连续久坐',()=>{
  const r=initiative.create(T0,{waterMs:4*MIN,workMs:3*MIN,entertainmentMs:10*MIN,guardUntil:T0+5*MIN});
  assert.equal(r.waterMs,4*MIN);assert.equal(r.workMs,0);assert.equal(r.entertainmentMs,0);assert.equal(r.guardUntil,T0+5*MIN);
});

test('忽略主动提醒后自动退场并释放队列，后续仍可继续提醒',()=>{
  let s=app.createInitialState({now:T0});s=app.reduce(s,{type:'initiative/demo',kind:'water'}).state;
  assert.equal(s.ui.bubble.autoDismissMs,20000);
  const result=app.reduce(s,{type:'tick',now:T0+21000});
  assert.equal(result.state.ui.bubble,null);assert.equal(result.state.queue.active,null);
  assert.ok(result.effects.some(e=>e.type==='pet-return'));
});

test('名单中的播放器无键鼠操作仍累计娱乐，锁屏不累计也不出招',()=>{
  const config=defaults({gameGuardEnabled:true,healthRemindersEnabled:false});
  assert.equal(runMinutes(2,config,{matchedApp:'vlc.exe',idleSeconds:900}).events.length,1);
  const locked=runMinutes(2,config,{matchedApp:'vlc.exe',idleSeconds:900,desktopActive:false});
  assert.equal(locked.events.length,0);assert.equal(locked.state.entertainmentMs,0);
});

function readyGuard(){
  let s=app.createInitialState({now:T0,settings:defaults({gameGuardEnabled:true,healthRemindersEnabled:false})});
  s=app.reduce(s,{type:'tasks/add',title:'写报告'}).state;s=app.reduce(s,{type:'bubble/dismiss'}).state;
  for(let t=0;t<=65000;t+=5000)s=app.reduce(s,{type:'activity/sample',now:T0+t,idleSeconds:0,matchedApp:'cs2.exe'}).state;
  return s;
}
test('娱乐到点等待本体走到面前后出招，同一提醒只演一次，下一次交替裂屏',()=>{
  let s=readyGuard();const first=s.ui.bubble.id;
  assert.equal(s.ui.bubble.guardEffect,'slash');assert.equal(s.pet.current,'reminder');
  let r=app.reduce(s,{type:'guard/perform',holder:first});assert.ok(r.ok);assert.equal(r.state.pet.effect,'slash');
  assert.equal(app.reduce(r.state,{type:'guard/perform',holder:first}).ok,false);
  assert.equal(r.state.initiative.guardEffectCount,1);
  s=app.reduce(r.state,{type:'effect/end',holder:first}).state;assert.equal(s.pet.current,'reminder');
  s=app.reduce(s,{type:'bubble/dismiss'}).state;s=app.reduce(s,{type:'initiative/demo',kind:'task_nudge'}).state;
  assert.equal(s.ui.bubble.guardEffect,'crack');
  r=app.reduce(s,{type:'guard/perform',holder:s.ui.bubble.id});assert.equal(r.state.pet.effect,'crack');
});
test('气泡取消、特效关闭或任务完成后，迟到的到达通知不会再出招',()=>{
  let s=readyGuard(),id=s.ui.bubble.id;
  s=app.reduce(s,{type:'bubble/dismiss'}).state;assert.equal(app.reduce(s,{type:'guard/perform',holder:id}).ok,false);
  s=readyGuard();id=s.ui.bubble.id;s=app.reduce(s,{type:'settings/update',patch:{guardEffectsEnabled:false}}).state;
  assert.equal(app.reduce(s,{type:'guard/perform',holder:id}).ok,false);
  s=readyGuard();id=s.ui.bubble.id;s=app.reduce(s,{type:'tasks/toggle',id:s.tasks[0].id}).state;
  assert.equal(app.reduce(s,{type:'guard/perform',holder:id}).ok,false);
});
test('出招中切回工作、开启免打扰或锁屏都会清理自动特效',()=>{
  for(const action of [{type:'settings/update',patch:{doNotDisturb:true}},
    {type:'activity/sample',now:T0+70000,idleSeconds:0,matchedApp:'',desktopActive:true},
    {type:'activity/sample',now:T0+70000,idleSeconds:0,matchedApp:'cs2.exe',desktopActive:false}]){
    let s=readyGuard();s=app.reduce(s,{type:'guard/perform',holder:s.ui.bubble.id}).state;
    const r=app.reduce(s,action);assert.ok(r.effects.some(e=>e.type==='effect-end'));assert.ok(r.effects.some(e=>e.type==='pet-return'));
    assert.notEqual(r.state.pet.current,'effect');
  }
});
test('完成一项就撒花，取消勾选不会撒花，全部做完停止催促',()=>{
  let s=readyGuard();s=app.reduce(s,{type:'tasks/add',title:'另一项'}).state;
  let r=app.reduce(s,{type:'tasks/toggle',id:s.tasks[0].id});assert.equal(r.allDone,false);assert.ok(r.effects.some(e=>e.name==='confetti'));
  r=app.reduce(r.state,{type:'tasks/toggle',id:s.tasks[0].id});assert.ok(!r.effects.some(e=>e.name==='confetti'));
});
test('全桌面游走只在娱乐、空闲或任务清空时允许，专注与锁屏会阻止',()=>{
  const base={pendingCount:1,idleSeconds:0,matchedApp:'',focusRunning:false,desktopActive:true};
  assert.equal(initiative.canRoam(base),false);
  assert.equal(initiative.canRoam({...base,idleSeconds:60}),true);
  assert.equal(initiative.canRoam({...base,matchedApp:'cs2.exe'}),true);
  assert.equal(initiative.canRoam({...base,pendingCount:0}),true);
  assert.equal(initiative.canRoam({...base,matchedApp:'cs2.exe',focusRunning:true}),false);
  assert.equal(initiative.canRoam({...base,idleSeconds:600,desktopActive:false}),false);
});
test('散步目标覆盖整张桌面和其他显示器，保持角色轮廓在可用范围内',()=>{
  const {pickWanderTarget}=require('../src/main/pet-visits.js');
  const displays=[{workArea:{x:0,y:0,width:1920,height:1040}},{workArea:{x:-1280,y:0,width:1280,height:900}}];
  const shape={left:100,top:200,right:240,bottom:370},targets=[];let seed=42;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<100;i++){
    const p=pickWanderTarget(displays,{x:1500,y:600},shape,random);targets.push(p);
    assert.ok(displays.some(({workArea:a})=>p.x+shape.left>=a.x-1&&p.x+shape.right<=a.x+a.width+1&&p.y+shape.top>=a.y-1&&p.y+shape.bottom<=a.y+a.height+1));
  }
  assert.ok(targets.some(p=>p.x< -600));assert.ok(targets.some(p=>p.x>1200));
  assert.ok(Math.max(...targets.map(p=>p.y))-Math.min(...targets.map(p=>p.y))>500);
});
