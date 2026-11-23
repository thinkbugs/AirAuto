'use strict';
(function(){
  const $=id=>document.getElementById(id);
  const timeFormat=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'});
  const dateFormat=new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric',weekday:'long'});
  function tick(){
    const now=new Date();
    const time=timeFormat.format(now);
    document.querySelectorAll('[data-clock]').forEach(node=>{node.textContent=time});
    const date=dateFormat.format(now);
    for(const id of ['top-date','home-date']){const node=$(id);if(node)node.textContent=date}
  }
  tick();
  setInterval(tick,1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});
})();
