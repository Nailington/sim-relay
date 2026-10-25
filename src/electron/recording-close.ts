import { ipcMain, type BrowserWindow } from 'electron';

/** Window closure is asynchronous, unlike browser beforeunload. Never approve an unanswered request. */
export function recordingCloseProtection(needsProtection: (owner: BrowserWindow) => boolean) {
  const pending = new Map<number, { owner: BrowserWindow; resolve(value: boolean): void }>();
  ipcMain.on('recording-close-response', (event, allowed) => {
    for (const [id, request] of pending) {
      if (
        request.owner.webContents !== event.sender ||
        event.senderFrame !== event.sender.mainFrame
      )
        continue;
      pending.delete(id);
      request.resolve(allowed === true && !needsProtection(request.owner));
    }
  });
  const ask = (owner: BrowserWindow, action = 'Close this window'): Promise<boolean> => {
    if (owner.isDestroyed() || !needsProtection(owner)) return Promise.resolve(true);
    // A repeated close/quit cannot borrow another in-flight decision.
    if (pending.has(owner.id)) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.set(owner.id, { owner, resolve });
      owner.show();
      owner.focus();
      owner.webContents.send('recording-close-request', action);
    });
  };
  return {
    ask,
    async confirmOwners(owners: BrowserWindow[], action: string) {
      for (const owner of owners) if (!(await ask(owner, action))) return false;
      // A previously confirmed owner may have started a new capture while another decided.
      return owners.every((owner) => owner.isDestroyed() || !needsProtection(owner));
    },
    protect(owner: BrowserWindow) {
      owner.on('close', (event) => {
        if (!needsProtection(owner)) return;
        event.preventDefault();
        void ask(owner).then((allowed) => {
          if (allowed && !owner.isDestroyed()) owner.close();
        });
      });
      const cancel = () => {
        const request = pending.get(owner.id);
        pending.delete(owner.id);
        request?.resolve(false);
      };
      owner.on('closed', cancel);
      owner.webContents.on('render-process-gone', cancel);
    },
  };
}
