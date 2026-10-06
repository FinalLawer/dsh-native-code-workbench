let electron = require("electron");
//#region lib/types/mandatory-update-ipc.js
/** Dependency-free IPC names shared with the sandboxed mandatory-update preload. */
const MANDATORY_IPC = {
	status: "dsh-desktop:mandatory-status",
	state: "dsh-desktop:mandatory-state",
	action: "dsh-desktop:mandatory-action"
};
//#endregion
//#region lib/types/preload-mandatory.js
/** Isolated bridge for the shell-owned mandatory-update modal only. */
const api = {
	status: () => electron.ipcRenderer.invoke(MANDATORY_IPC.status),
	action: (action, version, confirmationRevision) => electron.ipcRenderer.invoke(MANDATORY_IPC.action, action, version, confirmationRevision),
	subscribe(listener) {
		const handle = (_event, state) => {
			listener(state);
		};
		electron.ipcRenderer.on(MANDATORY_IPC.state, handle);
		return () => {
			electron.ipcRenderer.off(MANDATORY_IPC.state, handle);
		};
	}
};
if (location.href === "dsh-app://shell/mandatory-update.html") electron.contextBridge.exposeInMainWorld("dshMandatoryUpdate", api);
//#endregion
