'use strict';

// safari has not implemented FileSystemWritableFileStream
// so we need a worker to save files

addEventListener('message', async event => {
  if (event.data.type !== 'save') return;

  let { path, filename, data, idx } = event.data;
  try {
    let dir = await navigator.storage.getDirectory();

    for (let part of path) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }

    let file = await dir.getFileHandle(filename, { create: true });

    let handle = await file.createSyncAccessHandle();

    handle.write(data);
    handle.close();

    postMessage({ type: 'saved', idx });
  } catch (error) {
    postMessage({ type: 'error', error, idx });
  }
});
