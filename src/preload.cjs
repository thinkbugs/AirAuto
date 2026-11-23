const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('airauto',{call:(operation,data)=>ipcRenderer.invoke('call',operation,data),input:data=>ipcRenderer.send('input',data),on:callback=>{const listener=(_event,message)=>callback(message);ipcRenderer.on('event',listener);return ()=>ipcRenderer.removeListener('event',listener)}});
