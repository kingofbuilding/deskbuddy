/** 只绘制随桌宠本体定位的道具和环境反馈。 */
(function () {
  'use strict';
  const durations = window.DeskBuddy.effects.DURATIONS;
  const scenes = Object.fromEntries(Object.keys(durations).map((name) => [name, document.getElementById('fx-' + name)]));
  const colors = ['#ffce72','#ff98bc','#7edbff','#bba7ff','#a5efd3','#fff9e8'];
  let cleanupTimer = null, playing = null;
  function clearAll() {
    if (cleanupTimer !== null) clearTimeout(cleanupTimer); cleanupTimer = null;
    for (const scene of Object.values(scenes)) {
      scene.classList.remove('active');
      const host = scene.querySelector('.fx-particles, .glass-fracture'); if(host) host.textContent='';
    }
    playing = null; document.body.dataset.fx='';
  }
  function anchor(payload) {
    if(!payload || !payload.anchor) return;
    const a=payload.anchor;
    document.documentElement.style.setProperty('--hand-x',a.hand.x+'px');
    document.documentElement.style.setProperty('--hand-y',a.hand.y+'px');
    document.documentElement.dataset.actorHeight=String(a.body.height);
    document.documentElement.dataset.actorX=String(a.body.x);
  }
  function particles(scene, a) {
    const host=scene.querySelector('.fx-particles'); if(!host)return;
    const fragment=document.createDocumentFragment();
    for(let i=0;i<100;i++) {
      const piece=document.createElement('i');piece.className='fx-particle '+(i%3===0?'star':'');
      const angle=Math.PI*2*i/100, distance=15+Math.random()*38;
      const values={x:a.hand.x+'px',y:a.hand.y+'px',dx:Math.cos(angle)*distance+'vw',dy:(Math.sin(angle)*distance-20)+'vh',rot:Math.round(Math.random()*900-450)+'deg',size:8+Math.random()*12+'px',color:colors[i%colors.length],delay:120+Math.random()*250+'ms',travel:'2100ms'};
      for(const [key,value] of Object.entries(values))piece.style.setProperty('--'+key,value);
      fragment.appendChild(piece);
    }
    host.appendChild(fragment);
  }
  window.deskbuddyOverlay.onPlay((payload)=>{
    if(!payload || !Object.hasOwn(scenes,payload.name))return;
    clearAll();playing={name:payload.name,holder:payload.holder||''};
    const scene=scenes[payload.name],duration=durations[payload.name];
    const elapsed=Math.max(0,Date.now()-(payload.startedAt||Date.now()));
    const a=payload.anchor || {hand:{x:innerWidth*.8,y:innerHeight*.75},impact:{x:innerWidth*.8,y:innerHeight*.7},body:{x:innerWidth*.8,y:innerHeight*.75,width:176,height:176}};
    anchor({anchor:a});
    scene.style.setProperty('--life',duration+'ms'); scene.style.setProperty('--elapsed',-elapsed+'ms');
    scene.style.setProperty('--impact-delay',Math.max(0,400-elapsed)+'ms');
    document.body.dataset.fx=payload.name; void scene.offsetWidth;scene.classList.add('active');
    if(payload.name==='crack') {
      window.DeskBuddy.glass.render(scene.querySelector('.glass-fracture'),{impact:{x:a.impact.x,y:a.impact.y}});
    } else if(payload.name==='confetti')particles(scene,a);
    cleanupTimer=setTimeout(clearAll,Math.max(0,duration-elapsed));
  });
  if(window.deskbuddyOverlay.onAnchor)window.deskbuddyOverlay.onAnchor((payload)=>{
    if(playing && playing.name===payload.name && playing.holder===(payload.holder||''))anchor(payload);
  });
  window.addEventListener('pagehide',clearAll);
  document.documentElement.setAttribute('data-overlay-ready','true');window.deskbuddyOverlay.ready();
})();
