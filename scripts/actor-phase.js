'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Resvg}=require('@resvg/resvg-js');
const {waitForReady,sleep}=require('../src/main/selftest.js');
async function run({app,petWindow,getFxWindow,recoverPet}) {
 const js=(source)=>petWindow.webContents.executeJavaScript(source);
 const record=(name,ok,detail)=>{console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));if(!ok)throw new Error(name);};
 const output=path.join(__dirname,'..','docs','previews');
 async function composite(filename,withFx) {
   const overlay=getFxWindow();const screen=require('electron').screen.getPrimaryDisplay().bounds;
   const petBounds=petWindow.getBounds();
   const pet=(await petWindow.webContents.capturePage()).toPNG().toString('base64');
   const fx=withFx&&overlay?(await overlay.webContents.capturePage()).toPNG().toString('base64'):null;
   const fb=overlay?overlay.getBounds():screen;
   const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${screen.x} ${screen.y} ${screen.width} ${screen.height}" width="1440" height="${Math.round(1440*screen.height/screen.width)}"><rect x="${screen.x}" y="${screen.y}" width="${screen.width}" height="${screen.height}" fill="#d7e6ec"/><rect x="180" y="100" width="1000" height="680" rx="14" fill="#f9fbfc" stroke="#c2d1d9"/><path d="M180 145H1180" stroke="#d4dfe5"/><text x="210" y="130" fill="#607c8b" font-size="20" font-family="Microsoft YaHei">工作台</text><text x="230" y="215" fill="#244755" font-size="32" font-family="Microsoft YaHei">今天，慢慢把事情做好。</text><g fill="#92aab5"><rect x="230" y="260" width="640" height="12" rx="6"/><rect x="230" y="310" width="780" height="10" rx="5"/><rect x="230" y="360" width="560" height="10" rx="5"/></g>${fx?`<image href="data:image/png;base64,${fx}" x="${fb.x}" y="${fb.y}" width="${fb.width}" height="${fb.height}"/>`:''}<image href="data:image/png;base64,${pet}" x="${petBounds.x}" y="${petBounds.y}" width="${petBounds.width}" height="${petBounds.height}"/></svg>`;
   fs.writeFileSync(path.join(output,filename),new Resvg(svg).render().asPng());
 }
 try {
  record('界面就绪',await waitForReady(petWindow,15000));fs.mkdirSync(output,{recursive:true});
  if(process.argv.includes('--recover-pet')) {
   // 找回会先挥手；等动作完成后测静态透明边界，避免旋转帧与截图跨帧。
   await sleep(1800);
   record('任务栏找回命令启动后恢复正常大小',petWindow.isVisible()&&!petWindow.isMinimized()&&petWindow.getBounds().width===320&&await js(`getComputedStyle(document.getElementById('pet')).width==='176px'`));
  }
  await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{chatterEnabled:false,wanderEnabled:false,healthRemindersEnabled:false,effectsEnabled:true,doNotDisturb:false}});window.__deskbuddyDispatch({type:'bubble/dismiss'});document.getElementById('toast-host').textContent='';window.__originalActor=document.getElementById('pet');true`);
  await sleep(350);
  const box=await js(`(function(){var r=document.getElementById('pet').getBoundingClientRect();return{x:r.left,y:r.top,w:r.width,h:r.height};})()`);
  const png=await petWindow.webContents.capturePage();fs.writeFileSync(path.join(output,'pet-alone.png'),png.toPNG());
  const bounds=petWindow.getBounds(),bitmap=png.resize({width:bounds.width,height:bounds.height}).toBitmap();
  let outside=0;
  for(let y=0;y<bounds.height;y++)for(let x=0;x<bounds.width;x++)if(x<box.x-2||x>box.x+box.w+2||y<box.y-2||y>box.y+box.h+2){if(bitmap[(y*bounds.width+x)*4+3]>0)outside++;}
  record('本体以外完全透明，没有底板边框光晕',outside===0,{outsidePixels:outside});
  const hit=await js(`({empty:window.__deskbuddyPointerHit(10,10),face:window.__deskbuddyPointerHit(${box.x+box.w*.5},${box.y+box.h*.35})})`);
  record('空白穿透、角色像素可交互',!hit.empty.interactive&&hit.face.interactive,hit);
  const info=await js(`window.deskbuddy.getInfo()`);
  record('已创建托盘对象并加载专用图标',info.tray.ready,info.tray);
  if(!info.tray.bounds.width) console.log('INFO 系统未返回托盘图标位置，本项不能证明图标可见');
  const ignoring=[],setIgnore=petWindow.setIgnoreMouseEvents.bind(petWindow);
  petWindow.setIgnoreMouseEvents=(value,options)=>{ignoring.push(value);return setIgnore(value,options);};
  petWindow.webContents.send('main:message',{channel:'pet:pointer',payload:{x:10,y:10}});await sleep(100);
  petWindow.webContents.send('main:message',{channel:'pet:pointer',payload:{x:box.x+box.w*.5,y:box.y+box.h*.35}});await sleep(100);
  record('没有鼠标转发事件时原生位置推送仍能恢复点击',ignoring.includes(false),ignoring);
  petWindow.setIgnoreMouseEvents=setIgnore;
  const dragBefore=petWindow.getBounds();
  await js(`window.__dragErrors=[];window.addEventListener('error',e=>window.__dragErrors.push(e.message));document.getElementById('pet').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,screenX:800,screenY:600,bubbles:true}));true`);await sleep(80);
  await js(`document.getElementById('pet').dispatchEvent(new PointerEvent('pointermove',{button:0,pointerId:1,screenX:720,screenY:570,bubbles:true}));true`);await sleep(80);
  await js(`document.getElementById('pet').dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1,screenX:720,screenY:570,bubbles:true}));true`);await sleep(100);
  const dragAfter=petWindow.getBounds();
  record('拖动真实原生窗口且无运行错误',dragAfter.x===dragBefore.x-80&&dragAfter.y===dragBefore.y-30&&await js(`window.__dragErrors.length===0`),{before:dragBefore,after:dragAfter});
  petWindow.setPosition(dragBefore.x,dragBefore.y,false);
  await composite('pet-natural-desktop.png',false);
  record('主窗口允许最小化',petWindow.isMinimizable());
  await js(`window.deskbuddy.window.hidePet()`);await sleep(180);
  record('收起后只是最小化，主窗口仍在',petWindow.isMinimized()&&!petWindow.isDestroyed());
  await js(`window.deskbuddy.window.recover()`);await sleep(250);
  record('找回后可见且正常大小',!petWindow.isMinimized()&&petWindow.isVisible()&&petWindow.getBounds().width===320);
  const recall=await js(`window.deskbuddy.getInfo()`);record('提供找回快捷键状态',typeof recall.recallShortcut==='boolean');
  await js(`window.__deskbuddyDispatch({type:'effect/play',name:'slash',manual:true});true`);
  await sleep(1250);
  const fx=getFxWindow();record('特效覆盖层已创建',!!fx);
  record('演出操作原来那只本体',await js(`window.__originalActor===document.getElementById('pet') && document.getElementById('pet').dataset.performance==='slash'`));
  record('覆盖层没有第二份角色或海报',await fx.webContents.executeJavaScript(`document.querySelectorAll('img[src*="girl-"],.fx-hero,.fx-copy').length===0`));
  const before=await fx.webContents.executeJavaScript(`parseFloat(document.documentElement.style.getPropertyValue('--hand-x'))`);
  const p=petWindow.getBounds();petWindow.setPosition(p.x-80,p.y,false);await sleep(140);
  const after=await fx.webContents.executeJavaScript(`parseFloat(document.documentElement.style.getPropertyValue('--hand-x'))`);
  record('移动本体时刀柄同步跟随',Math.abs(after-before+80)<15,{before,after});
  await composite('effect-slash.png',true);
  const impact=await js(`window.__deskbuddyDispatch({type:'effect/play',name:'crack',manual:true});window.__deskbuddyActorAnchor().impact`);
  await sleep(700);
  const actual=await fx.webContents.executeJavaScript(`({x:Number(document.querySelector('.glass-fracture').dataset.impactX),y:Number(document.querySelector('.glass-fracture').dataset.impactY)})`);
  const pb=petWindow.getBounds(),fb=fx.getBounds();
  record('裂屏来自本体拳头位置',Math.abs(actual.x-(pb.x+impact.x-fb.x))<10&&Math.abs(actual.y-(pb.y+impact.y-fb.y))<10,{actual,impact});
  record('出拳仍是同一只角色',await js(`window.__originalActor===document.getElementById('pet') && document.getElementById('pet').dataset.performance==='crack'`));
  await composite('effect-crack.png',true);
  await js(`window.__deskbuddyDispatch({type:'effect/end'});window.__deskbuddyDispatch({type:'initiative/demo',kind:'break'});true`);await sleep(1600);
  record('关怀由原本桌宠走来并说话',await js(`window.__originalActor===document.getElementById('pet') && window.__deskbuddySnapshot().bubble==='break'`));
  record('关怀层没有任何角色贴图',await fx.webContents.executeJavaScript(`document.getElementById('fx-reminder').children.length===0`));
  await composite('effect-break.png',true);await composite('effect-reminder.png',true);
  recoverPet();await sleep(200);
  await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{petScale:.75}});window.deskbuddy.window.setScale(.75)`);
  record('可以缩小',petWindow.getBounds().width===240);
  await js(`window.deskbuddy.window.recover()`);await sleep(160);
  record('缩小或走丢后找回会恢复大小位置',petWindow.getBounds().width===320&&await js(`getComputedStyle(document.getElementById('pet')).width==='176px'`));
  console.log('PHASE_RESULT=PASS');app.exit(0);
 }catch(error){console.error(error.stack);console.log('PHASE_RESULT=FAIL');app.exit(1);}
}
module.exports={run};
