'use strict';
const {screen}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const windows=require('../src/main/pet-window.js');
const {waitForReady,sleep}=require('../src/main/selftest.js');
async function run({app,petWindow,taskbarWindow}){
 const js=s=>petWindow.webContents.executeJavaScript(s);
 const record=(name,ok,detail)=>{console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));if(!ok)throw Error(name);};
 const click=()=>js(`(()=>{const p=document.getElementById('pet');for(const type of ['pointerdown','pointerup'])p.dispatchEvent(new PointerEvent(type,{button:0,screenX:800,screenY:600,bubbles:true}));return true;})()`);
 try{
  record('界面就绪',await waitForReady(petWindow,15000));
  await js(`window.__deskbuddyDispatch({type:'settings/update',patch:{chatterEnabled:false,wanderEnabled:false,lifeEnabled:false,healthRemindersEnabled:false}});window.__deskbuddyDispatch({type:'bubble/dismiss'});true`);await sleep(350);
  const info=await js(`window.deskbuddy.getInfo()`);
  record('独立标准任务栏窗口已就绪',info.taskbar.ready&&info.taskbar.minimized&&taskbarWindow.isMinimizable(),info.taskbar);
  await js(`window.deskbuddy.window.hidePet()`);await sleep(120);
  record('桌宠收起',petWindow.isMinimized());
  taskbarWindow.restore();await sleep(250);
  record('恢复任务栏窗口会唤醒桌宠',petWindow.isVisible()&&!petWindow.isMinimized()&&taskbarWindow.isVisible());
  const output=path.join(__dirname,'..','docs','previews');fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'taskbar-control.png'),(await taskbarWindow.webContents.capturePage()).toPNG());
  taskbarWindow.close();await sleep(120);
  record('关闭控制台只最小化，任务栏入口保留',!taskbarWindow.isDestroyed()&&taskbarWindow.isMinimized());
  const area=screen.getDisplayMatching(petWindow.getBounds()).workArea;
  for(const [edge,dx,dy] of [['left',-3000,0],['right',3000,0],['top',0,-3000],['bottom',0,3000]]){
   await js(`(async()=>{await window.deskbuddy.window.beginDrag();await window.deskbuddy.window.dragTo(${dx},${dy});await window.deskbuddy.window.endDrag();return true;})()`);
   const b=petWindow.getBounds(),s=windows.petShape(b.width,b.height);
   const gap=edge==='left'?b.x+s.left-area.x:edge==='right'?area.x+area.width-b.x-s.right:edge==='top'?b.y+s.top-area.y:area.y+area.height-b.y-s.bottom;
   record('角色轮廓可贴'+edge+'边',Math.abs(gap)<=1,{gap,position:{x:b.x,y:b.y}});
  }
  const edgeHome=petWindow.getBounds();await click();await sleep(150);
  record('贴边展开菜单时向屏内避让',await js(`document.getElementById('quick-menu').classList.contains('visible')`)&&petWindow.getBounds().y<edgeHome.y);
  await js(`document.querySelector('[data-action="close-menu"]').click();true`);await sleep(100);
  record('收起按钮关闭菜单并返回贴边位置',!(await js(`document.getElementById('quick-menu').classList.contains('visible')`))&&petWindow.getBounds().y===edgeHome.y);
  await click();await sleep(120);
  petWindow.webContents.send('main:message',{channel:'pet:pointer',payload:{x:-2000,y:-2000}});await sleep(520);
  record('离开菜单和角色后自动收起',!(await js(`document.getElementById('quick-menu').classList.contains('visible')`)));
  await click();await sleep(100);
  petWindow.webContents.send('main:message',{channel:'pet:state',payload:{closeMenu:true}});await sleep(50);
  record('点击其他窗口失焦会关闭菜单',!(await js(`document.getElementById('quick-menu').classList.contains('visible')`)));
  console.log('PHASE_RESULT=PASS');app.exit(0);
 }catch(error){console.error(error.stack);console.log('PHASE_RESULT=FAIL');app.exit(1);}
}
module.exports={run};
