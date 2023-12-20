'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

let PORT = 31482; // 'oai' in base 36

let SAVE_OUTPUTS = true; // save outputs locally

let OPENAI_API_KEY = fs.readFileSync(path.join(__dirname, 'OPENAI_KEY.txt'), 'utf8').trim();

let outdir = path.join(__dirname, 'outputs');
if (SAVE_OUTPUTS) {
  fs.mkdirSync(outdir, { recursive: true });
}

let app = express();
app.use(express.json());
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});
for (let file of ['page.js', 'save-worker.js']) {
  app.get('/' + file, function (req, res) {
    res.setHeader('content-type', 'text/javascript');
    res.sendFile(path.join(__dirname, file));
  });
}

app.post('/image', async (req, res) => {
  console.log('working...');
  let { prompt, ts, quality, style } = req.body;

  if (SAVE_OUTPUTS) {
    fs.writeFileSync(path.join(outdir, `${ts}--prompt.txt`), prompt, 'utf8');
    fs.writeFileSync(path.join(outdir, `${ts}--settings.txt`), `quality: ${quality}\nstyle: ${style}\n`, 'utf8');
  }

  // specifically not using the openai npm package so that we can do this the same way on the web
  let result = await (await fetch('https://api.openai.com/v1/images/generations', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
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
  })).json();

  if (SAVE_OUTPUTS && result.data?.[0]?.b64_json) {
    fs.writeFileSync(path.join(outdir, `${ts}--image.png`), Buffer.from(result.data[0].b64_json, 'base64'));
    fs.writeFileSync(path.join(outdir, `${ts}--revised.txt`), result.data[0].revised_prompt, 'utf8');
  }

  res.json(result);
});

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
