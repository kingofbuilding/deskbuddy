'use strict';
// 游走覆盖各显示器的可用桌面；home 始终保留用户最后拖放的位置。
function pickWanderTarget(displays,origin,shape,random=Math.random) {
  let target;
  for(let attempt=0;attempt<8;attempt++){
    const area=displays[Math.min(displays.length-1,Math.floor(random()*displays.length))].workArea;
    target={x:Math.round(area.x-shape.left+random()*Math.max(0,area.width-(shape.right-shape.left))),
      y:Math.round(area.y-shape.top+random()*Math.max(0,area.height-(shape.bottom-shape.top)))};
    if(Math.hypot(target.x-origin.x,target.y-origin.y)>=Math.min(300,Math.min(area.width,area.height)*.4))break;
  }
  return target;
}
function createPetVisits(options) {
  const {screen,getWindow,onMotion}=options;
  const random=options.random||Math.random;
  let home=null,moving=null,returning=null,currentKind='',currentHolder='';
  const available=()=>{const win=getWindow();return win&&!win.isDestroyed()?win:null;};
  function clearTimers(){if(moving)clearInterval(moving);if(returning)clearTimeout(returning);moving=returning=null;}
  function moveTo(win,destination,done,slow=false){
    const origin=win.getBounds(),started=Date.now(),kind=currentKind,holder=currentHolder;
    const duration=slow?Math.max(1100,Math.min(6500,Math.hypot(destination.x-origin.x,destination.y-origin.y)/280*1000)):1100;
    onMotion({walking:true,facing:destination.x>=origin.x?'right':'left',kind,holder});
    moving=setInterval(()=>{
      if(win.isDestroyed()){clearTimers();home=null;return;}
      const t=Math.min(1,(Date.now()-started)/duration),ease=t*t*(3-2*t);
      win.setPosition(Math.round(origin.x+(destination.x-origin.x)*ease),Math.round(origin.y+(destination.y-origin.y)*ease),false);
      if(t===1){clearInterval(moving);moving=null;onMotion({walking:false,arrived:true,kind,holder});if(done)done();}
    },32);
  }
  function cancel(restore){
    clearTimers();const win=available(),destination=home;currentKind=currentHolder='';
    onMotion({walking:false,cancelled:true});
    if(restore&&win&&destination)moveTo(win,destination,()=>{home=null;});else home=null;
    return {ok:true};
  }
  function visit(kind,holder=''){
    const win=available();if(!win||!win.isVisible()||win.isMinimized())return {ok:false,error:'pet_hidden'};
    if(home){if(currentKind==='wander'&&kind!=='wander')clearTimers();else return {ok:false,error:'already_visiting'};}
    const origin=win.getBounds(),area=screen.getDisplayMatching(origin).workArea;
    if(!home)home={x:origin.x,y:origin.y};currentKind=kind;currentHolder=holder;
    if(kind==='wander'){
      let hops=3;
      const hop=()=>{
        const b=win.getBounds(),shape=options.getShape?options.getShape(b.width,b.height):{left:0,top:0,right:b.width,bottom:b.height};
        const target=pickWanderTarget(screen.getAllDisplays(),b,shape,random);
        moveTo(win,target,()=>{returning=setTimeout(--hops>0?hop:()=>cancel(true),2000+random()*1800);},true);
      };
      hop();
    }else{
      const x=area.x+(area.width-origin.width)/2,y=kind==='task_nudge'?area.y+(area.height-origin.height)/2:area.y+area.height-origin.height-20;
      const target={x:Math.round(Math.min(area.x+area.width-origin.width,Math.max(area.x,x))),y:Math.round(Math.min(area.y+area.height-origin.height,Math.max(area.y,y)))};
      moveTo(win,target,()=>{returning=setTimeout(()=>cancel(true),12000);});
    }
    return {ok:true};
  }
  return {visit,cancel,homePosition:()=>home,kind:()=>currentKind,dispose:()=>cancel(false)};
}
module.exports={createPetVisits,pickWanderTarget};
