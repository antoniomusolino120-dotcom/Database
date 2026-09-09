import { app, BrowserWindow, ipcMain, shell, powerSaveBlocker } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from './services/database.js';
import { SheetsService, DEFAULT_SPREADSHEET_ID } from './services/sheets.js';
import { CollectorEngine } from './services/collectorEngine.js';
import { MunicipalityService } from './services/municipalities.js';
import { integratedBrowserInfo } from './services/browserCollector.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUERIES=['tattoo','tatuatore','tattoo studio','studio tatuaggi','tattoo artist'];
let win,db,sheets,municipalities,engine,blockerId=null;

function emit(payload){if(win&&!win.isDestroyed())win.webContents.send('collector:event',payload);}

async function createWindow(){
  win=new BrowserWindow({width:1450,height:930,minWidth:1040,minHeight:700,title:'FindMyInk Collector',backgroundColor:'#0b0b0d',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});
  if(process.env.VITE_DEV_SERVER_URL)await win.loadURL(process.env.VITE_DEV_SERVER_URL);else await win.loadFile(path.join(app.getAppPath(),'renderer','dist','index.html'));
}

function settingsPayload(){return{
  spreadsheetId:db.getSetting('spreadsheetId',DEFAULT_SPREADSHEET_ID),sheetEndpoint:sheets.getEndpoint(),queries:db.getSetting('queries',DEFAULT_QUERIES),browser:integratedBrowserInfo(),
  minDelayMs:db.getSetting('minDelayMs',1100),maxDelayMs:db.getSetting('maxDelayMs',2600),maxResultsPerQuery:db.getSetting('maxResultsPerQuery',300),maxScrollsPerQuery:db.getSetting('maxScrollsPerQuery',60),sheetBatchSize:db.getSetting('sheetBatchSize',250)
};}

function installIpc(){
  ipcMain.handle('bootstrap',async()=>{
    let municipalityLoadError='';
    if(db.municipalityCount()<7000){try{await municipalities.ensureLoaded();}catch(err){municipalityLoadError=err.message;}}
    if(sheets.hasEndpoint()&&!sheets.isConnected())await sheets.testConnection().catch(()=>{});
    return {municipalities:db.listMunicipalities({limit:250}),summary:db.summary(),state:db.getCollectorState(),settings:settingsPayload(),sheet:{configured:sheets.hasEndpoint(),connected:sheets.isConnected()},municipalityLoadError};
  });

  ipcMain.handle('save-settings',async(_e,patch)=>{
    for(const [k,v] of Object.entries(patch||{}))if(k!=='sheetEndpoint')db.setSetting(k,v);
    if(patch.spreadsheetId)sheets.setSpreadsheetId(patch.spreadsheetId);
    return settingsPayload();
  });

  ipcMain.handle('municipalities',async(_e,opts={})=>db.listMunicipalities(opts));
  ipcMain.handle('reload-municipalities',async()=>{const count=await municipalities.ensureLoaded();return{count,summary:db.summary(),municipalities:db.listMunicipalities({limit:250})};});
  ipcMain.handle('retry-errors',async()=>({count:db.retryMunicipalityErrors(),summary:db.summary(),municipalities:db.listMunicipalities({limit:250})}));
  ipcMain.handle('reset-municipalities',async()=>{if(engine.running)throw new Error('Ferma prima il Collector');db.resetMunicipalities();return{summary:db.summary(),municipalities:db.listMunicipalities({limit:250}),state:db.getCollectorState()};});

  ipcMain.handle('sheet-configure',async(_e,url)=>{const r=await sheets.configureEndpoint(url);emit({type:'sheet-sync',connected:r.connected});return r;});
  ipcMain.handle('sheet-test',async()=>{const r=await sheets.testConnection();emit({type:'sheet-sync',connected:true});return r;});
  ipcMain.handle('sheet-sync-now',async()=>sheets.syncAll(db.getSetting('sheetBatchSize',250),p=>emit({type:'sync-progress',...p})));

  ipcMain.handle('focus-browser',async()=>engine.focusBrowser());
  ipcMain.handle('start-collector',async(_e,options={})=>{
    if(engine.running)return{started:false,reason:'already-running'};
    const settings={queries:db.getSetting('queries',DEFAULT_QUERIES),minDelayMs:db.getSetting('minDelayMs',1100),maxDelayMs:db.getSetting('maxDelayMs',2600),maxResultsPerQuery:db.getSetting('maxResultsPerQuery',300),maxScrollsPerQuery:db.getSetting('maxScrollsPerQuery',60),sheetBatchSize:db.getSetting('sheetBatchSize',250),...options};
    if(blockerId!==null&&powerSaveBlocker.isStarted(blockerId))powerSaveBlocker.stop(blockerId);
    blockerId=powerSaveBlocker.start('prevent-app-suspension');
    engine.start(settings).catch(err=>emit({type:'fatal',message:err.message})).finally(()=>{if(blockerId!=null&&powerSaveBlocker.isStarted(blockerId))powerSaveBlocker.stop(blockerId);blockerId=null;});
    return{started:true};
  });
  ipcMain.handle('pause-collector',async()=>{engine.pause();return true;});
  ipcMain.handle('resume-collector',async()=>{engine.resume();return true;});
  ipcMain.handle('stop-collector',async()=>{engine.stop();return true;});
  ipcMain.handle('entities',async(_e,limit=500)=>db.listEntities(limit));
  ipcMain.handle('summary',async()=>({summary:db.summary(),state:db.getCollectorState(),sheet:{configured:sheets.hasEndpoint(),connected:sheets.isConnected()}}));
  ipcMain.handle('open-data-folder',async()=>shell.openPath(app.getPath('userData')));
}

app.whenReady().then(async()=>{
  const userData=app.getPath('userData');
  db=new DatabaseService(userData);
  if(db.getSetting('collectorSchemaVersion',0)<3){
    db.setSetting('queries',DEFAULT_QUERIES);db.setSetting('maxResultsPerQuery',300);db.setSetting('maxScrollsPerQuery',60);db.setSetting('collectorSchemaVersion',3);
    const purged=db.purgeExplicitForeignEntities();if(purged.length)db.log('info','Rimossi record esteri raccolti dalla V2',{count:purged.length,ids:purged});
  }
  sheets=new SheetsService(userData,db,db.getSetting('spreadsheetId',DEFAULT_SPREADSHEET_ID));
  municipalities=new MunicipalityService(db,emit);
  engine=new CollectorEngine({db,sheets,municipalities,userDataPath:userData,event:emit});
  installIpc();
  await createWindow();
  municipalities.ensureLoaded().catch(err=>emit({type:'warning',message:err.message}));
  if(sheets.hasEndpoint())sheets.testConnection().then(()=>emit({type:'sheet-sync',connected:true})).catch(err=>emit({type:'sheet-sync',connected:false,message:err.message}));
});

app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
app.on('before-quit',()=>{try{engine?.stop();db?.close();}catch{}});
