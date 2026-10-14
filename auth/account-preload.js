'use strict';
const {contextBridge,ipcRenderer} = require('electron');
const send = (name,...args) => ipcRenderer.invoke(`opencluely-siwc:${name}`,...args);
contextBridge.exposeInMainWorld('siwcAccount',Object.freeze({
  state:()=>send('state'),
  signIn:()=>send('sign-in'),
  reauthorize:()=>send('reauthorize'),
  disconnect:()=>send('disconnect'),
  addAccount:()=>send('add-account'),
  chooseProfile:id=>send('choose-profile',id),
  selectModel:model=>send('select-model',model),
  test:()=>send('test'),
  usage:()=>send('usage'),
  close:()=>send('close'),
}));
