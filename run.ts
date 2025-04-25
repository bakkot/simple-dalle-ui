import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';

let PORT = 31482; // 'oai' in base 36

let SAVE_OUTPUTS = true; // save outputs locally

let OPENAI_API_KEY = fs.readFileSync(path.join(import.meta.dirname, 'OPENAI_KEY.txt'), 'utf8').trim();
let openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let ALLOWED_USERS = fs.readFileSync(path.join(import.meta.dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

let outdir = path.join(import.meta.dirname, 'outputs');
if (SAVE_OUTPUTS) {
  fs.mkdirSync(outdir, { recursive: true });
}

let app = express();
app.use(express.json());
app.get('/', function (req, res) {
  res.sendFile(path.join(import.meta.dirname, 'index.html'));
});
for (let file of ['page.js', 'save-worker.js']) {
  app.get('/' + file, function (req, res) {
    res.setHeader('content-type', 'text/javascript');
    res.sendFile(path.join(import.meta.dirname, file));
  });
}

app.post('/check-user', (req, res) => {
  let { user } = req.body;
  if (ALLOWED_USERS.includes(user)) {
    res.send('ok');
  } else {
    res.send('fail');
  }
});

app.post('/image', multer({ storage: multer.memoryStorage() }).array('images'), async (req, res) => {
  let { prompt, ts, quality, user } = req.body;
  if (!ALLOWED_USERS.includes(user)) {
    res.status(403);
    res.send('unknown user');
    return;
  }
  console.log('working...');

  if (SAVE_OUTPUTS) {
    fs.writeFileSync(path.join(outdir, `${ts}--prompt.txt`), prompt, 'utf8');
    fs.writeFileSync(path.join(outdir, `${ts}--settings.txt`), `user: ${user}\nquality: ${quality}\n`, 'utf8');
  }

  let result;
  try {
    if (Array.isArray(req.files) && req.files.length > 0) {
      result = await openai.images.edit({
        model: 'gpt-image-1',
        prompt,
        image: await Promise.all(req.files.map(f => OpenAI.toFile(f.buffer, f.originalname, { type: f.mimetype }))),
        quality,
      });
    } else {
      result = await openai.images.generate({
        model: 'gpt-image-1',
        prompt,
        size: '1024x1024',
        moderation: 'low',
        quality,
      });
    }
  } catch (e) {
    console.log(e);
    // @ts-expect-error
    res.json({ error: e?.message ?? e?.error?.message ?? e?.toString() ?? 'unknown error' });
    return;
  }

  console.log('done');
  // console.log(result);

  const image_base64 = result.data![0].b64_json!;

  if (SAVE_OUTPUTS && result.data?.[0]?.b64_json) {
    // Save the image to a file
    fs.writeFileSync(path.join(outdir, `${ts}--image.png`), Buffer.from(image_base64, 'base64'));
  }

  res.json(result);
});

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
