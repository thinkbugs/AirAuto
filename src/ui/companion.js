'use strict';
(function(){
  const $=id=>document.getElementById(id);
  const put=(id,value)=>{const node=$(id);if(node)node.textContent=value};
  const pad=n=>String(n).padStart(2,'0');
  const dateFormat=new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric',weekday:'long'});
  let duration=0,artUrl='';
  function tick(){const now=new Date();document.querySelectorAll('[data-clock]').forEach(node=>{node.textContent=pad(now.getHours())+':'+pad(now.getMinutes())});const date=$('date');if(date)date.textContent=dateFormat.format(now)}
  tick();setInterval(tick,1000);
  function format(ms){const seconds=Math.max(0,Math.floor((ms||0)/1000));return pad(Math.floor(seconds/60))+':'+pad(seconds%60)}
  function setConnected(live){const dot=$('dot');if(dot)dot.classList.toggle('connected',live)}
  function nowPlaying(state,artChanged){
    duration=state.durationMs||0;
    put('track',state.title||'暂无播放');put('artist',[state.artist,state.album].filter(Boolean).join(' · '));
    if(artChanged){if(artUrl)URL.revokeObjectURL(artUrl);artUrl=state.artwork&&state.artwork.length?URL.createObjectURL(new Blob([new Uint8Array(state.artwork)],{type:state.artwork[0]===137?'image/png':'image/jpeg'})):'';const art=$('art');if(art){art.hidden=!artUrl;if(artUrl)art.src=artUrl;else art.removeAttribute('src')}}
    const seek=$('seek');if(seek){seek.max=duration||1;seek.disabled=!state.canSeek||!duration}
    put('time',format(state.positionMs||0)+' / '+format(duration));
  }
  airauto.on(message=>{
    if(message.type==='appearance')document.body.classList.toggle('dark',!!message.dark);
    if(message.type==='status'){put('state',message.status+(message.detail?' · '+message.detail:''));setConnected(true)}
    if(message.type==='connected'){put('state','接收中');setConnected(true)}
    if(message.type==='stopped'){put('state','未连接');setConnected(false)}
    if(message.type==='metrics'){put('fps',message.decodedFps?message.decodedFps.toFixed(1)+' fps':'—');put('size',message.decodedWidth?message.decodedWidth+'×'+message.decodedHeight:'—')}
    if(message.type==='now-playing')nowPlaying(message.state,message.artChanged);
    if(message.type==='position'){const seek=$('seek');if(seek)seek.value=Math.min(duration||1,message.positionMs||0);put('time',format(message.positionMs)+' / '+format(duration))}
  });
  airauto.call('state').then(result=>{if(!result||!result.ok)return;document.body.classList.toggle('dark',!!result.dark);put('state',result.running?'接收中':'未连接');setConnected(!!result.running);const s=result.settings||{};if(s.wallpaper==='custom'&&s.wallpaperFile){document.body.style.backgroundImage='linear-gradient(180deg,rgba(6,10,16,.32),rgba(6,10,16,.76)), url("airauto-media://wallpapers/'+encodeURIComponent(s.wallpaperFile)+'")';document.body.style.backgroundSize='cover';document.body.style.backgroundPosition='center'}}).catch(()=>{});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();airauto.input({command:'video-minimize'})}});
})();
