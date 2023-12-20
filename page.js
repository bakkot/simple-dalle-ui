'use strict';

let USES_SERVER = false; // change to true if self-hosting

let opfsDir = 'dalle';

function makeSave() {
  let worker = new Worker('save-worker.js');

  let promiseMap = new Map;
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
function addHistoryItem(url, prompt, revised, ts, quality, style) {
  let box = document.createElement('span');
  box.classList.add('gallery-box');
  box.style.position = 'relative';

  let img = document.createElement('img');
  img.src = url;
  img.width = 128;
  img.height = 128;
  img.alt = revised;

  img.addEventListener('click', () => {
    activeImg = img;
    modal(url, prompt, revised, quality, style);
  });

  box.append(img);


  let trash = document.getElementById('trash-icon').cloneNode(true);
  trash.style.display = '';
  trash.classList.add('trash');
  box.append(trash);

  trash.addEventListener('click', async e => {
    async function remove() {
      let opfsRoot = await navigator.storage.getDirectory();
      let dalleDir = await opfsRoot.getDirectoryHandle(opfsDir);
      await dalleDir.removeEntry(`${ts}--image.png`);
      await dalleDir.removeEntry(`${ts}--prompt.txt`);
      await dalleDir.removeEntry(`${ts}--revised.txt`);
      try {
        await dalleDir.removeEntry(`${ts}--settings.txt`);
      } catch { /* probably predates settings */ }

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

function modal(url, prompt, revised, quality, style) {
  let modal = document.querySelector('.history-modal');

  let contents = modal.querySelector('.modal-contents');
  contents.innerHTML = '';

  let p = document.createElement('p');
  p.innerText = prompt;
  contents.append(p);

  if (quality !== 'standard' || style !== 'natural') {
    let p = document.createElement('p');
    let extra = [
      ...quality !== 'standard' ? [quality] : [],
      ...style !== 'natural' ? [style] : [],
    ].join(', ');
    p.innerText = `(${extra})`;
    contents.append(p);
  }

  let img = document.createElement('img');
  img.src = url;
  img.width = 512;
  img.height = 512;
  img.alt = revised;
  contents.append(img);

  let bq = document.createElement('blockquote');
  bq.innerText = revised;
  contents.append(bq);

  modal.showModal();
}

document.addEventListener('keydown', e => {
  if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') {
    return;
  }
  let modal = document.querySelector('.history-modal');
  if (!modal.open || activeImg == null) return;

  let gallery = document.querySelector('.gallery');
  let imgs = [...gallery.querySelectorAll('img')];

  let idx = imgs.indexOf(activeImg);
  if (idx === -1) return;

  if (e.code === 'ArrowLeft') {
    if (idx === 0) return;
    imgs[idx - 1].click();
  } else {
    if (idx === imgs.length - 1) return;
    imgs[idx + 1].click();
  }
});


// only used if USES_SERVER === false;
// set during init
let apiKey;

let working = false;
async function submit() {
  if (working) return;

  let inputEle = document.querySelector('.input');
  let prompt = inputEle.value.trim();
  if (prompt === '') return;

  working = true;
  inputEle.disabled = true;

  let output = document.querySelector('.output');
  output.style.display = 'none';

  output.querySelector('img')?.remove();
  let bq = output.querySelector('blockquote');
  bq.innerText = '';
  bq.style.color = '';

  let spinner = document.querySelector('.spinner');
  spinner.style.display = 'flex';

  let quality = document.querySelector('#hd').checked ? 'hd' : 'standard';
  let style = document.querySelector('#vivid').checked ? 'vivid' : 'natural';

  try {
    let ts = (new Date).toISOString().replace(/:/g, '_');
    let res;
    if (USES_SERVER) {
      let message = {
        prompt,
        ts,
        quality,
        style,
      };
      res = await (await fetch('./image', {
        method: 'post',
        body: JSON.stringify(message),
        headers: { 'content-type': 'application/json' }
      })).json();
    } else {
      res = await (await fetch('https://api.openai.com/v1/images/generations', {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
          quality,
          style,
        }),
      })).json()
    }

    if (res.error) {
      throw new Error(res.error.message);
    }

    console.log(res);

    let { b64_json, revised_prompt } = res.data[0];

    let data = base64ToUint8Array(b64_json);
    let blob = new Blob([data], { type: 'image/png' });
    let url = URL.createObjectURL(blob);
    let img = document.createElement('img');
    img.src = url;
    img.width = 512;
    img.height = 512;

    output.prepend(img);
    bq.innerText = revised_prompt;

    addHistoryItem(url, prompt, revised_prompt, ts, quality, style);

    await save([opfsDir], `${ts}--image.png`, data);
    await save([opfsDir], `${ts}--prompt.txt`, (new TextEncoder).encode(prompt));
    await save([opfsDir], `${ts}--settings.txt`, (new TextEncoder).encode(`quality: ${quality}\nstyle: ${style}\n`));
    await save([opfsDir], `${ts}--revised.txt`, (new TextEncoder).encode(revised_prompt));
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

addEventListener('DOMContentLoaded', async () => {
  // history dialog

  let history = document.querySelector('.history-modal');
  // surely there's a better way
  let dismiss = modal => e => {
    let dims = modal.getBoundingClientRect();
    if (
      e.clientX < dims.left ||
      e.clientX > dims.right ||
      e.clientY < dims.top ||
      e.clientY > dims.bottom
    ) {
      modal.close();
    }
  };
  history.addEventListener('click', dismiss(history));

  document.querySelector('.close-history')
    .addEventListener('click', () => { history.close(); });


  // delete-confirmation dialog

  let confirmDelete = document.querySelector('.confirm-delete-modal');
  confirmDelete.addEventListener('click', dismiss(confirmDelete));

  confirmDelete.querySelector('#confirm-cancel')
    .addEventListener('click', () => {
      confirmDelete.close();
    });
  confirmDelete.querySelector('#confirm-delete')
    .addEventListener('click', () => {
      confirmDelete.close();
      removeActiveImage();
    });


  // API key dialog

  if (!USES_SERVER) {
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

    apiKeyDialog.querySelector('#api-key-confirm')
      .addEventListener('click', confirmKey);

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

  document.querySelector('.send-button-container')
    .addEventListener('click', submit);


  // populate gallery

  let opfsRoot = await navigator.storage.getDirectory();

  let dalleDir = await opfsRoot.getDirectoryHandle(opfsDir, {create: true});

  let old = { __proto__: null };
  for await (let [name, handle] of dalleDir) {
    if (!name.includes('--')) continue;
    let [ts, type] = name.split('--');
    old[ts] ??= {};
    let obj = old[ts];

    obj[type] = handle;
  }
  for (let [ts, handles] of Object.entries(old).sort((a, b) => a[0] > b[0] ? 1 : -1)) {
    let { 'image.png': imageH, 'prompt.txt': promptH, 'revised.txt': revisedH, 'settings.txt': settingsH } = handles;
    if (imageH == null || promptH == null || revisedH == null) {
      // presumably an error saving, I guess? might as well clean up
      for (let name of Object.keys(handles)) {
        await dalleDir.removeEntry(`${ts}--${name}`);
      }
      continue;
    }
    let image = await imageH.getFile();
    let prompt = await (await promptH.getFile()).text();
    let revised = await (await revisedH.getFile()).text();
    let settings = settingsH ? await (await settingsH.getFile()).text() : `quality: standard\nstyle: natural\n`;
    let { quality, style } = settings.match(/quality: (?<quality>\w+)\nstyle: (?<style>\w+)/).groups;

    addHistoryItem(URL.createObjectURL(image), prompt, revised, ts, quality, style);
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
    let triplet =
      (map.get(c1) << 18) +
      (map.get(c2) << 12) +
      (map.get(c3) << 6) +
      map.get(c4);

    result.push(
      (triplet >> 16) & 255,
      (triplet >> 8) & 255,
      triplet & 255
    );
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
