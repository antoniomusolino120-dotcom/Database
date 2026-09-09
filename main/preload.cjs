const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('collector',{
  bootstrap:()=>ipcRenderer.invoke('bootstrap'),
  saveSettings:(patch)=>ipcRenderer.invoke('save-settings',patch),
  municipalities:(opts)=>ipcRenderer.invoke('municipalities',opts),
  reloadMunicipalities:()=>ipcRenderer.invoke('reload-municipalities'),
  retryErrors:()=>ipcRenderer.invoke('retry-errors'),
  resetMunicipalities:()=>ipcRenderer.invoke('reset-municipalities'),
  configureSheet:(url)=>ipcRenderer.invoke('sheet-configure',url),
  testSheet:()=>ipcRenderer.invoke('sheet-test'),
  syncNow:()=>ipcRenderer.invoke('sheet-sync-now'),
  focusBrowser:()=>ipcRenderer.invoke('focus-browser'),
  start:(options)=>ipcRenderer.invoke('start-collector',options),
  pause:()=>ipcRenderer.invoke('pause-collector'),
  resume:()=>ipcRenderer.invoke('resume-collector'),
  stop:()=>ipcRenderer.invoke('stop-collector'),
  entities:(limit)=>ipcRenderer.invoke('entities',limit),
  summary:()=>ipcRenderer.invoke('summary'),
  openDataFolder:()=>ipcRenderer.invoke('open-data-folder'),
  onEvent:(callback)=>{const handler=(_event,payload)=>callback(payload);ipcRenderer.on('collector:event',handler);return()=>ipcRenderer.removeListener('collector:event',handler);}
});
