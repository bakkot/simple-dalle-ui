'use strict';

let opfsDir = 'dalle';

function makeSave() {
  let worker = new Worker('save-worker.js');

  let promiseMap = new Map();
  let runningIdx = 0;

  worker.addEventListener('message', event => {
    if (['saved', 'error'].includes(event.data.type)) {
      let { idx } = event.data;
      let cap = promiseMap.get(idx);
      if (cap == null) {
        console.error(`got bad idx ${idx}`);
        return;
      }
      if (event.data.type === 'saved') {
        cap.resolve();
      } else {
        cap.reject(event.data.error);
      }
      promiseMap.delete(idx);
    } else {
      console.error(`got bad message type ${event.data.type}`);
    }
  });

  return function save(path, filename, data) {
    return new Promise((resolve, reject) => {
      let idx = runningIdx++;
      promiseMap.set(idx, { resolve, reject });
      worker.postMessage({ type: 'save', path, filename, data, idx }, [data.buffer]);
    });
  };
}

let save = makeSave();

// this is mutated when clicking the trash icon
let removeActiveImage = () => {
  console.error('unreachable');
};

let activeImg = null;
function addHistoryItem(blob, prompt, ts, service) {
  let url = URL.createObjectURL(blob);
  let box = document.createElement('span');
  box.classList.add('gallery-box');
  box.style.position = 'relative';

  let element, isVideo = service === 'seedance';

  if (isVideo) {
    element = document.createElement('video');
    element.src = url;
    element.style.maxWidth = '128px';
    element.style.maxHeight = '128px';
    element.muted = true;
    element.loop = true;
    element.preload = 'metadata';
  } else {
    element = document.createElement('img');
    element.src = url;
    element.style.maxWidth = '128px';
    element.style.maxHeight = '128px';
    element.alt = prompt;
  }

  element.addEventListener('click', () => {
    activeImg = element;
    modal(url, prompt, service);
  });

  box.append(element);

  let trash = document.getElementById('trash-icon').cloneNode(true);
  trash.style.display = '';
  trash.classList.add('trash');
  box.append(trash);

  // Only add plus button for images, not videos
  if (!isVideo) {
    let plus = document.getElementById('plus-icon').cloneNode(true);
    plus.style.display = '';
    plus.classList.add('plus');
    box.append(plus);

    plus.addEventListener('click', () => {
      addImage(blob);
    });
  }

  trash.addEventListener('mousedown', async e => {
    async function remove() {
      let opfsRoot = await navigator.storage.getDirectory();
      let dalleDir = await opfsRoot.getDirectoryHandle(opfsDir);
      let fileExtension = isVideo ? 'video.mp4' : 'image.png';
      await dalleDir.removeEntry(`${ts}--${fileExtension}`);
      await dalleDir.removeEntry(`${ts}--prompt.txt`);
      try {
        await dalleDir.removeEntry(`${ts}--settings.txt`);
      } catch {
        /* probably predates settings */
      }

      box.remove();
    }
    e.preventDefault();
    if (e.shiftKey) {
      remove();
    } else {
      removeActiveImage = remove;
      document.querySelector('.confirm-delete-modal').showModal();
    }
  });

  document.querySelector('.gallery').append(box);
}

function modal(url, prompt, service) {
  let modal = document.querySelector('.history-modal');

  let contents = modal.querySelector('.modal-contents');
  contents.innerHTML = '';

  let p = document.createElement('p');
  p.innerText = prompt;
  contents.append(p);

  let p2 = document.createElement('p');
  p2.innerText = `(service: ${service})`;
  contents.append(p2);

  let element;
  if (service === 'seedance') {
    element = document.createElement('video');
    element.src = url;
    element.style.maxWidth = '512px';
    element.style.maxHeight = '512px';
    element.controls = true;
    element.loop = true;
    element.muted = true;
    element.autoplay = true;
  } else {
    element = document.createElement('img');
    element.src = url;
    element.style.maxWidth = '512px';
    element.style.maxHeight = '512px';
    element.alt = prompt;
  }
  contents.append(element);

  modal.showModal();
}

document.addEventListener('keydown', e => {
  if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') {
    return;
  }
  let modal = document.querySelector('.history-modal');
  if (!modal.open || activeImg == null) return;

  let gallery = document.querySelector('.gallery');
  let elements = [...gallery.querySelectorAll('img, video')];

  let idx = elements.indexOf(activeImg);
  if (idx === -1) return;

  if (e.code === 'ArrowLeft') {
    if (idx === 0) return;
    elements[idx - 1].click();
  } else {
    if (idx === elements.length - 1) return;
    elements[idx + 1].click();
  }
});

let working = false;
async function submit() {
  if (working) return;

  let inputEle = document.querySelector('.input');
  let prompt = inputEle.value.trim();
  if (prompt === '') return;

  let service = document.querySelector('input[name="service"]:checked').value;

  localStorage.setItem('dalle-ui-service', service);

  if (service === 'kontext' && inputImages.length !== 1) {
    let errorModal = document.querySelector('.service-error-modal');
    let errorMessage = document.querySelector('#service-error-message');
    if (inputImages.length === 0) {
      errorMessage.innerText = 'Kontext only does image editing; you need to attach an image.';
    } else {
      errorMessage.innerText = `Kontext only supports a single image as input.`;
    }
    errorModal.showModal();
    return;
  }

  if (service === 'seedance' && inputImages.length > 1) {
    let errorModal = document.querySelector('.service-error-modal');
    let errorMessage = document.querySelector('#service-error-message');
    errorMessage.innerText = `Seedance only supports a single image as input.`;
    errorModal.showModal();
    return;
  }

  working = true;
  inputEle.disabled = true;

  let output = document.querySelector('.output');
  output.style.display = 'none';

  output.querySelector('img')?.remove();
  output.querySelector('video')?.remove();
  let bq = output.querySelector('blockquote');
  bq.innerText = '';
  bq.style.color = '';

  let spinner = document.querySelector('.spinner');
  spinner.style.display = 'flex';

  try {
    let ts = new Date().toISOString().replace(/:/g, '_');
    let body = new FormData();
    body.set('prompt', prompt);
    body.set('ts', ts);
    body.set('service', service);
    body.set('user', user);

    if (service === 'seedance') {
      body.set('fps', document.getElementById('fps').value);
      body.set('duration', document.getElementById('duration').value);
      body.set('resolution', document.getElementById('resolution').value);
      body.set('aspect_ratio', document.getElementById('aspect-ratio').value);
      body.set('camera_fixed', document.getElementById('camera-fixed').checked);
    }

    if (service === 'openai' && inputImages.length > 0) {
      body.set('input_fidelity', document.querySelector('input[name="input-fidelity"]:checked').value);
    }

    for (let image of inputImages) {
      body.append('images', image);
    }

    let res = await (
      await fetch('./image', {
        method: 'post',
        body,
      })
    ).json();

    if (res.error) {
      let message = res.error.message ?? res.error ?? 'unknown error';
      throw new Error(message);
    }

    let { b64 } = res;

    let data = base64ToUint8Array(b64);
    let blob, url, element, filename;

    if (service === 'seedance') {
      blob = new Blob([data], { type: 'video/mp4' });
      url = URL.createObjectURL(blob);
      element = document.createElement('video');
      element.src = url;
      element.style.maxWidth = '512px';
      element.style.maxHeight = '512px';
      element.controls = true;
      element.loop = true;
      element.muted = true;
      element.autoplay = true;
      filename = `${ts}--video.mp4`;
    } else {
      blob = new Blob([data], { type: 'image/png' });
      url = URL.createObjectURL(blob);
      element = document.createElement('img');
      element.src = url;
      element.style.maxWidth = '512px';
      element.style.maxHeight = '512px';
      filename = `${ts}--image.png`;
    }

    output.prepend(element);

    addHistoryItem(blob, prompt, ts, service);

    await save([opfsDir], filename, data);
    await save([opfsDir], `${ts}--prompt.txt`, new TextEncoder().encode(prompt));
    let settingsText = `service: ${service}\n`;
    if (service === 'seedance') {
      settingsText += `fps: ${document.getElementById('fps').value}\n`;
      settingsText += `duration: ${document.getElementById('duration').value}\n`;
      settingsText += `resolution: ${document.getElementById('resolution').value}\n`;
      settingsText += `aspect_ratio: ${document.getElementById('aspect-ratio').value}\n`;
      settingsText += `camera_fixed: ${document.getElementById('camera-fixed').checked}\n`;
    }
    if (service === 'openai' && inputImages.length > 0) {
      settingsText += `input_fidelity: ${document.querySelector('input[name="input-fidelity"]:checked').value}\n`;
    }
    await save([opfsDir], `${ts}--settings.txt`, new TextEncoder().encode(settingsText));
  } catch (e) {
    console.error(e);
    bq.innerText = 'ERROR: ' + e.message;
    bq.style.color = 'red';
  }
  working = false;
  inputEle.disabled = false;
  output.style.display = '';
  spinner.style.display = '';
}

let inputImages = [];

addEventListener('DOMContentLoaded', async () => {
  // show/hide service-specific parameters based on service selection
  function toggleServiceSpecificInputs() {
    let service = document.querySelector('input[name="service"]:checked').value;
    let videoParams = document.getElementById('video-params');
    let openaiParams = document.getElementById('openai-params');
    
    videoParams.style.display = service === 'seedance' ? 'block' : 'none';
    openaiParams.style.display = service === 'openai' ? 'block' : 'none';
  }

  document.querySelectorAll('input[name="service"]').forEach(radio => {
    radio.addEventListener('change', toggleServiceSpecificInputs);
  });

  let savedService = localStorage.getItem('dalle-ui-service');
  if (savedService) {
    let serviceRadio = document.querySelector(`input[name="service"][value="${savedService}"]`);
    if (serviceRadio) {
      serviceRadio.checked = true;
    }
  }

  // Ensure params are shown/hidden correctly after loading saved service
  toggleServiceSpecificInputs();

  // history dialog

  let history = document.querySelector('.history-modal');
  // surely there's a better way
  let dismiss = modal => e => {
    let dims = modal.getBoundingClientRect();
    if (e.clientX < dims.left || e.clientX > dims.right || e.clientY < dims.top || e.clientY > dims.bottom) {
      modal.close();
    }
  };
  history.addEventListener('click', dismiss(history));

  document.querySelector('.close-history').addEventListener('click', () => {
    history.close();
  });

  // delete-confirmation dialog

  let confirmDelete = document.querySelector('.confirm-delete-modal');
  confirmDelete.addEventListener('click', dismiss(confirmDelete));

  confirmDelete.querySelector('#confirm-cancel').addEventListener('click', () => {
    confirmDelete.close();
  });
  confirmDelete.querySelector('#confirm-delete').addEventListener('click', () => {
    confirmDelete.close();
    removeActiveImage();
  });

  // service error dialog

  let serviceErrorModal = document.querySelector('.service-error-modal');
  serviceErrorModal.addEventListener('click', dismiss(serviceErrorModal));

  serviceErrorModal.querySelector('#service-error-ok').addEventListener('click', () => {
    serviceErrorModal.close();
  });

  // API key dialog

  if (false) {
    let apiKeyDialog = document.querySelector('.api-key');
    apiKeyDialog.addEventListener('click', dismiss(apiKeyDialog));

    let apiKeyInput = apiKeyDialog.querySelector('.api-key-input');
    function confirmKey() {
      apiKey = apiKeyInput.value.trim();
      apiKeyDialog.close();
    }

    apiKeyInput.addEventListener('keydown', e => {
      if (e.code === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        confirmKey();
      }
    });

    apiKeyDialog.querySelector('#api-key-confirm').addEventListener('click', confirmKey);

    apiKeyDialog.showModal();
    apiKeyDialog.querySelector('a').blur();
  }

  // input

  let inputEle = document.querySelector('.input');
  function fixupTextboxSize() {
    inputEle.parentNode.dataset.replicatedValue = inputEle.value;
  }
  inputEle.addEventListener('input', fixupTextboxSize);
  inputEle.addEventListener('keydown', e => {
    if (e.code === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      submit();
    }
  });

  document.querySelector('.send-button-container').addEventListener('click', submit);

  // image previews

  let imageUpload = document.getElementById('imageUpload');

  imageUpload.addEventListener('change', function () {
    let files = this.files;
    for (let i = 0; i < files.length; i++) {
      let file = files.item(i);
      if (file) {
        addImage(file);
      }
    }
    this.value = '';
  });

  // populate gallery

  let opfsRoot = await navigator.storage.getDirectory();

  let dalleDir = await opfsRoot.getDirectoryHandle(opfsDir, { create: true });

  let old = { __proto__: null };
  for await (let [name, handle] of dalleDir) {
    if (!name.includes('--')) continue;
    let [ts, type] = name.split('--');
    old[ts] ??= {};
    let obj = old[ts];

    obj[type] = handle;
  }
  for (let [ts, handles] of Object.entries(old).sort((a, b) => (a[0] > b[0] ? 1 : -1))) {
    let { 'image.png': imageH, 'video.mp4': videoH, 'prompt.txt': promptH, 'settings.txt': settingsH } = handles;
    let mediaHandle = imageH || videoH;
    if (mediaHandle == null || promptH == null) {
      // presumably an error saving, I guess? might as well clean up
      for (let name of Object.keys(handles)) {
        await dalleDir.removeEntry(`${ts}--${name}`);
      }
      continue;
    }
    let media = await mediaHandle.getFile();
    let prompt = await (await promptH.getFile()).text();
    let settings = settingsH ? await (await settingsH.getFile()).text() : `service: openai\n`;
    let serviceMatch = settings.match(/service: (?<service>\w+)/);
    let qualityMatch = settings.match(/quality: (?<quality>\w+)/);
    let service = serviceMatch ? serviceMatch.groups.service : (qualityMatch ? qualityMatch.groups.quality : 'openai');

    addHistoryItem(media, prompt, ts, service);
  }
});

// for debug
async function clearFS() {
  let opfsRoot = await navigator.storage.getDirectory();
  await opfsRoot.removeEntry(opfsDir, { recursive: true });
}

// https://github.com/tc39/proposal-arraybuffer-base64/blob/ed073ef6bf63b6bb0e081e338bddf551f6a722c8/playground/polyfill-core.mjs
let base64Characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let base64UrlCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

let tag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
function checkUint8Array(arg) {
  let kind;
  try {
    kind = tag.call(arg);
  } catch {
    throw new TypeError('not a Uint8Array');
  }
  if (kind !== 'Uint8Array') {
    throw new TypeError('not a Uint8Array');
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assert failed: ${message}`);
  }
}

function getOptions(options) {
  if (typeof options === 'undefined') {
    return Object.create(null);
  }
  if (options && typeof options === 'object') {
    return options;
  }
  throw new TypeError('options is not object');
}

function base64ToUint8Array(string, options) {
  if (typeof string !== 'string') {
    throw new TypeError('expected input to be a string');
  }
  let opts = getOptions(options);
  let alphabet = opts.alphabet;
  if (typeof alphabet === 'undefined') {
    alphabet = 'base64';
  }
  if (alphabet !== 'base64' && alphabet !== 'base64url') {
    throw new TypeError('expected alphabet to be either "base64" or "base64url"');
  }
  let strict = !!opts.strict;
  let input = string;

  if (!strict) {
    input = input.replaceAll(/[\u0009\u000A\u000C\u000D\u0020]/g, '');
  }
  if (input.length % 4 === 0) {
    if (input.length > 0 && input.at(-1) === '=') {
      input = input.slice(0, -1);
      if (input.length > 0 && input.at(-1) === '=') {
        input = input.slice(0, -1);
      }
    }
  } else if (strict) {
    throw new SyntaxError('not correctly padded');
  }

  let map = new Map((alphabet === 'base64' ? base64Characters : base64UrlCharacters).split('').map((c, i) => [c, i]));
  if ([...input].some(c => !map.has(c))) {
    let bad = [...input].filter(c => !map.has(c));
    throw new SyntaxError(`contains illegal character(s) ${JSON.stringify(bad)}`);
  }

  let lastChunkSize = input.length % 4;
  if (lastChunkSize === 1) {
    throw new SyntaxError('bad length');
  } else if (lastChunkSize === 2 || lastChunkSize === 3) {
    input += 'A'.repeat(4 - lastChunkSize);
  }
  assert(input.length % 4 === 0);

  let result = [];
  let i = 0;
  for (; i < input.length; i += 4) {
    let c1 = input[i];
    let c2 = input[i + 1];
    let c3 = input[i + 2];
    let c4 = input[i + 3];
    let triplet = (map.get(c1) << 18) + (map.get(c2) << 12) + (map.get(c3) << 6) + map.get(c4);

    result.push((triplet >> 16) & 255, (triplet >> 8) & 255, triplet & 255);
  }

  if (lastChunkSize === 2) {
    if (strict && result.at(-2) !== 0) {
      throw new SyntaxError('extra bits');
    }
    result.splice(-2, 2);
  } else if (lastChunkSize === 3) {
    if (strict && result.at(-1) !== 0) {
      throw new SyntaxError('extra bits');
    }
    result.pop();
  }

  return new Uint8Array(result);
}

function addImage(file) {
  inputImages.push(file);

  let reader = new FileReader();
  let previewContainer = document.createElement('div');
  previewContainer.classList.add('image-preview-container');
  let img = document.createElement('img');
  img.classList.add('image-preview');

  let removeButton = document.getElementById('trash-icon').cloneNode(true);
  removeButton.style.display = '';
  removeButton.classList.add('trash');

  reader.onload = function (event) {
    img.src = event.target.result;
  };

  removeButton.addEventListener('click', function () {
    previewContainer.remove();
    inputImages.splice(inputImages.indexOf(file), 1);
  });

  previewContainer.appendChild(img);
  previewContainer.appendChild(removeButton);
  imagePreviews.appendChild(previewContainer);

  reader.readAsDataURL(file);
}

let user;
let userDialog = document.querySelector('.user');
let userStatus = document.querySelector('#user-status');

let userInput = userDialog.querySelector('.user-input');

async function isUserGood(user) {
  try {
    let res = await fetch('check-user', { method: 'post', body: JSON.stringify({ user }), headers: { 'content-type': 'application/json' } });
    if (!res.ok) {
      return { good: false, error: 'network request failed' };
    }
    res = await res.text();
    if (res === 'ok') {
      return { good: true, error: null };
    } else if (res === 'fail') {
      return { good: false, error: 'unrecognized user' };
    } else {
      return { good: false, error: 'unknown error' };
    }
  } catch (e) {
    return { good: false, error: 'network request failed' };
  }
}

async function confirmUser() {
  let attemptedUser = userInput.value.trim();
  userStatus.style.color = 'initial';
  userStatus.innerText = 'checking...';

  let { good, error } = await isUserGood(attemptedUser);
  if (good) {
    user = attemptedUser;
    userStatus.innerText = 'ok!';
    if (document.querySelector('#save-user').checked) {
      localStorage.setItem('chatgpt-ui-user', user);
    }
    setTimeout(() => userDialog.close(), 500);
  } else {
    userStatus.style.color = 'red';
    userStatus.innerText = error;
  }
}

userInput.addEventListener('keydown', e => {
  if (e.code === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    confirmUser();
  }
});

userDialog.querySelector('#user-confirm')
  .addEventListener('click', confirmUser);

userDialog.addEventListener('cancel', e => {
    e.preventDefault();
});

let savedUser = localStorage.getItem('chatgpt-ui-user');
if (savedUser != null) {
  (async () => {
    let { good } = await isUserGood(savedUser);
    if (good) {
      user = savedUser;
    } else {
      userDialog.showModal();
    }
  })();
} else {
  userDialog.showModal();
}
