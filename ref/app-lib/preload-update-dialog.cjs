let electron = require("electron");
//#region lib/types/update-dialog.js
/** Main-owned update confirmations; closing or replacing a dialog never grants installation permission. */
/** Channels available only to the isolated update-dialog document. */
const UPDATE_DIALOG_IPC = {
	status: "dsh-update-dialog:status",
	changed: "dsh-update-dialog:changed",
	respond: "dsh-update-dialog:respond"
};
//#endregion
//#region lib/types/preload-update-dialog.js
/** Isolated response-only bridge for shell-owned update dialogs. */
const api = {
	status: () => electron.ipcRenderer.invoke(UPDATE_DIALOG_IPC.status),
	respond: (revision, index) => electron.ipcRenderer.invoke(UPDATE_DIALOG_IPC.respond, revision, index),
	subscribe: (listener) => {
		const receive = (_event, view) => {
			listener(view);
		};
		electron.ipcRenderer.on(UPDATE_DIALOG_IPC.changed, receive);
		return () => {
			electron.ipcRenderer.removeListener(UPDATE_DIALOG_IPC.changed, receive);
		};
	}
};
if (location.href === "dsh-app://shell/update-dialog.html") electron.contextBridge.exposeInMainWorld("dshUpdateDialog", api);
//#endregion
