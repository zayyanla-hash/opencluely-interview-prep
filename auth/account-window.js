'use strict';
const {app, BrowserWindow, ipcMain, globalShortcut, Menu, shell} = require('electron');
const path = require('node:path');
const bridge = require('./electron-bridge');
let accountWindow;
let configured = false;

function openAccountWindow() {
  if (accountWindow && !accountWindow.isDestroyed()) {
    accountWindow.show(); accountWindow.focus(); return;
  }
  accountWindow = new BrowserWindow({
    width:580, height:650, minWidth:520, minHeight:560,
    title:'OpenCluely · ChatGPT account',
    backgroundColor:'#f6f6f4',
    show:true,
    webPreferences:{
      preload:path.join(__dirname,'account-preload.js'),
      contextIsolation:true, sandbox:true, nodeIntegration:false,
      webSecurity:true, partition:'opencluely-account',
    },
  });
  accountWindow.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  accountWindow.webContents.on('will-navigate', e => e.preventDefault());
  accountWindow.webContents.session.setPermissionRequestHandler((_wc,_perm,cb)=>cb(false));
  accountWindow.loadFile(path.join(__dirname,'account.html'));
  accountWindow.on('closed',()=>{accountWindow=null;});
}
function guard(event) {
  if (!accountWindow || accountWindow.isDestroyed() || event.sender !== accountWindow.webContents || event.senderFrame !== accountWindow.webContents.mainFrame)
    throw new Error('Unauthorized account-window request');
}
function handler(name,action) {
  ipcMain.handle(`opencluely-siwc:${name}`,(event,...args)=> {guard(event);return action(...args);});
}
function install({autoOpen = true} = {}) {
  if (configured) return;
  configured=true;
  app.whenReady().then(async()=>{
    handler('state',()=>bridge.getState());
    handler('sign-in',()=>bridge.call('signIn',{},null,660_000));
    handler('reauthorize',()=>bridge.call('signIn',{reconsent:true},null,660_000));
    handler('disconnect',()=>bridge.call('disconnect'));
    handler('add-account',()=>bridge.call('signIn',{newProfile:true},null,660_000));
    handler('choose-profile', id=>bridge.call('selectProfile',{id}));
    handler('select-model', async model=>{
      const models = await bridge.call('listModels');
      if (!models.some(item=>item.slug === model)) throw new Error('Model not available to the current account');
      bridge.setPreference(model); return true;
    });
    handler('test', async()=>{
      const model = await bridge.chooseModel();
      const answer = await bridge.call('run',{model,input:[{role:'user',content:'Reply exactly: Connected successfully.'}]},null,60000);
      return {model,answer};
    });
    handler('usage',()=>shell.openExternal('https://chatgpt.com/settings/usage'));
    handler('close',()=>accountWindow?.close());
    globalShortcut.register('CommandOrControl+Shift+G',openAccountWindow);
    const existing = Menu.getApplicationMenu();
    // Keep the upstream menu structure where possible while adding discoverability.
    if (existing && existing.items.length > 0) {
      const menu = Menu.buildFromTemplate([
        {label:'OpenCluely',submenu:[
          {label:'ChatGPT Account…',accelerator:'CommandOrControl+Shift+G',click:openAccountWindow},
          {role:'separator'}, {role:'quit'},
        ]},
        ...existing.items.slice(1),
      ]);
      Menu.setApplicationMenu(menu);
    } else {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        {label:'OpenCluely',submenu:[{label:'ChatGPT Account…',accelerator:'CommandOrControl+Shift+G',click:openAccountWindow},{type:'separator'},{role:'quit'}]},
        {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      ]));
    }
    try {
      const state = await bridge.getState();
      if (autoOpen && !state.session.sharing) setTimeout(openAccountWindow,1200);
    } catch {if (autoOpen) setTimeout(openAccountWindow,1200);}
  }).catch(()=>{});
}
module.exports = {install,openAccountWindow};
