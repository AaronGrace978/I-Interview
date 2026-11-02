import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../src/contracts.js";
const subscribe = <T,>(channel: string, callback: (data: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: T) =>
    callback(data);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};
const bridge: DesktopBridge = {
  avatarStatus: () => ipcRenderer.invoke("avatar:status"),
  avatarGpu: () => ipcRenderer.invoke("avatar:gpu"),
  avatarPrepare: (avatarId, consent) =>
    ipcRenderer.invoke("avatar:prepare", { avatarId, consent }),
  avatarJob: (id) => ipcRenderer.invoke("avatar:job", id),
  avatarImportVoice: (consent) => ipcRenderer.invoke("avatar:voice", consent),
  avatarOffer: (avatarId, sdp, consent) =>
    ipcRenderer.invoke("avatar:offer", { avatarId, sdp, consent }),
  avatarSpeak: (request) => ipcRenderer.invoke("avatar:speak", request),
  avatarInterrupt: () => ipcRenderer.invoke("avatar:interrupt"),
  avatarStop: () => ipcRenderer.invoke("avatar:stop"),
  credentialStatus: () => ipcRenderer.invoke("credentials:status"),
  saveCredential: (provider, key) =>
    ipcRenderer.invoke("credentials:save", { provider, key }),
  deleteCredential: (provider) =>
    ipcRenderer.invoke("credentials:delete", provider),
  listModels: (provider) => ipcRenderer.invoke("models:list", provider),
  generate: (request) => ipcRenderer.invoke("interview:generate", request),
  cancel: (id) => ipcRenderer.invoke("interview:cancel", id),
  onToken: (callback) => subscribe("interview:token", callback),
  cloneVoice: (name, audio, mime, consent) =>
    ipcRenderer.invoke("voice:clone", { name, audio, mime, consent }),
  deleteVoice: (id) => ipcRenderer.invoke("voice:delete", id),
  speak: (id, text) => ipcRenderer.invoke("voice:speak", { id, text }),
  stopSpeech: () => ipcRenderer.invoke("voice:stop"),
  transcribe: (audio, mime, consent) =>
    ipcRenderer.invoke("audio:transcribe", { audio, mime, consent }),
  onAudio: (callback) => subscribe("voice:audio", callback),
  checkUpdate: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdate: (callback) => {
    let active = true;
    const off = subscribe("updates:status", callback);
    void ipcRenderer
      .invoke("updates:status")
      .then((data) => {
        if (active) callback(data);
      })
      .catch(() => {});
    return () => {
      active = false;
      off();
    };
  },
};
contextBridge.exposeInMainWorld("interview", bridge);
