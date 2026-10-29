'use strict';
const api=window.deskbuddy;
document.getElementById('recover').addEventListener('click',()=>api.window.recover());
document.getElementById('hide').addEventListener('click',()=>api.window.hidePet());
document.getElementById('quit').addEventListener('click',()=>api.window.quit());
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',async()=>{await api.window.showPet();await api.window.openPanel(button.dataset.panel);}));
