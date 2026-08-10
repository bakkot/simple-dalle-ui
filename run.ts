import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { fal } from "@fal-ai/client";

let PORT = 31482; // 'oai' in base 36

let SAVE_OUTPUTS = true; // save outputs locally

let OPENAI_API_KEY = fs.readFileSync(path.join(import.meta.dirname, 'OPENAI_KEY.txt'), 'utf8').trim();
let FAL_API_KEY = fs.readFileSync(path.join(import.meta.dirname, 'FAL_KEY.txt'), 'utf8').trim();
let openai = new OpenAI({ apiKey: OPENAI_API_KEY });
fal.config({
  credentials: FAL_API_KEY,
});

let ALLOWED_USERS = fs.readFileSync(path.join(import.meta.dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

let outdir = path.join(import.meta.dirname, 'outputs');
if (SAVE_OUTPUTS) {
  fs.mkdirSync(outdir, { recursive: true });
}

let videos = ['seedance', 'wan', 'h3'];

// how long to wait for the upstream API before switching to the poll-for-a-result strategy
let LONG_POLL_TIMEOUT = 5_000;
let RESULT_TTL = 24 * 60 * 60 * 1000;

type Result =
  | { state: 'working'; ts: number; ext: string }
  | { state: 'error'; ts: number; ext: string; error: string }
  | { state: 'done'; ts: number; ext: string; buffer: Buffer };

// not persisted; results are lost on restart, which is fine
let results = new Map<string, Result>();

function sweepResults() {
  let now = Date.now();
  for (let [id, result] of results) {
    if (now - result.ts > RESULT_TTL) {
      results.delete(id);
    }
  }
}

async function fetchToBase64(url: string) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString('base64');
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
  let { prompt, ts, service, user, fps, duration, resolution, aspect_ratio, camera_fixed, input_fidelity, enhance_prompt, guidance, prompt_upsampling, nanobanana_resolution, prompt_expansion } = req.body;
  if (!ALLOWED_USERS.includes(user)) {
    res.status(403);
    res.send('unknown user');
    return;
  }
  console.log(`working (${service})...`);

  sweepResults();

  if (SAVE_OUTPUTS) {
    fs.writeFileSync(path.join(outdir, `${ts}--prompt.txt`), prompt, 'utf8');
    let settingsText = `user: ${user}\nservice: ${service}\n`;
    if (service === 'openai' && input_fidelity) {
      settingsText += `input_fidelity: ${input_fidelity}\n`;
    } else if (service === 'seedance') {
      settingsText += `fps: ${fps}\nduration: ${duration}\nresolution: ${resolution}\naspect_ratio: ${aspect_ratio}\ncamera_fixed: ${camera_fixed}\n`;
    } else if (service === 'wan') {
      settingsText += `resolution: ${resolution}\naspect_ratio: ${aspect_ratio}\n`;
    } else if (service === 'h3') {
      settingsText += `duration: ${duration}\nresolution: ${resolution}\naspect_ratio: ${aspect_ratio}\nprompt_expansion: ${prompt_expansion}\n`;
    } else if (service === 'qwen') {
      settingsText += `aspect_ratio: ${aspect_ratio}\n`;
      settingsText += `guidance: ${guidance}\n`;
    } else if (service === 'nanobanana') {
      settingsText += `resolution: ${nanobanana_resolution}\n`;
    }
    fs.writeFileSync(path.join(outdir, `${ts}--settings.txt`), settingsText, 'utf8');
    if (Array.isArray(req.files)) {
      for (let i = 0; i < req.files.length; ++i) {
        let file = req.files[i];
        let ext = contentTypeToExt[file.mimetype];
        if (ext == null) {
          ext = '.unknown';
        }
        fs.writeFileSync(path.join(outdir, `${ts}--input-image-${i}${ext}`), file.buffer);
      }
    }
  }

  let generate = async (): Promise<string> => {
    let output_base64: string;
    if (service === 'openai') {
      let res;
      if (Array.isArray(req.files) && req.files.length > 0) {
        let editParams: any = {
          model: 'gpt-image-2',
          prompt,
          image: await Promise.all(req.files.map(f => OpenAI.toFile(f.buffer, f.originalname, { type: f.mimetype }))),
          quality: 'high',
        };
        if (input_fidelity) {
          editParams.input_fidelity = input_fidelity;
        }
        res = await openai.images.edit(editParams);
      } else {
        res = await openai.images.generate({
          model: 'gpt-image-2',
          prompt,
          // size: '1024x1024',
          size: 'auto',
          moderation: 'low',
          quality: 'high',
        });
      }
      output_base64 = res.data![0].b64_json!;
    // } else if (service === 'kontext') {
    //   if (!Array.isArray(req.files) || req.files?.length !== 1) {
    //     throw new Error('kontext expects exactly one image as input');
    //   }
    //   let f = req.files[0];
    //   let res = await replicate.run('black-forest-labs/flux-kontext-pro', {
    //     input: {
    //       prompt,
    //       input_image: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
    //       safety_tolerance: 6,
    //       prompt_upsampling: prompt_upsampling === 'true',
    //     },
    //   }) as FileOutput;
    //   let blob = await res.blob();
    //   output_base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    } else if (service === 'seedance') {
      let input: any = {
        fps: parseInt(fps) || 24,
        prompt,
        duration: parseInt(duration) || 5,
        resolution: resolution || '480p',
        aspect_ratio: aspect_ratio || '16:9',
        camera_fixed: camera_fixed === 'true',
        enable_safety_checker: false,
      };

      let model = 'fal-ai/bytedance/seedance/v1/pro/text-to-video';
      if (Array.isArray(req.files) && req.files.length > 0) {
        if (req.files.length !== 1) {
          throw new Error('seedance expects zero or one image as input');
        }
        model = 'fal-ai/bytedance/seedance/v1/pro/image-to-video';
        let f = req.files[0];
        input.image_url = new File([f.buffer as Buffer<ArrayBuffer>], f.filename);
      }

      let res = await fal.subscribe(model, { input });
      let { url } = res.data.video;
      output_base64 = await fetchToBase64(url);
    } else if (service === 'wan') {
      let input: any = {
        prompt,
        resolution: resolution || '480p',
        aspect_ratio: aspect_ratio || '16:9',
        enable_safety_checker: false,
      };

      let model = 'fal-ai/wan/v2.2-a14b/text-to-video';
      if (Array.isArray(req.files) && req.files.length > 0) {
        if (req.files.length !== 1) {
          throw new Error('wan expects zero or one image as input');
        }
        model = 'fal-ai/wan/v2.2-a14b/image-to-video';
        let f = req.files[0];
        input.image_url = new File([f.buffer as Buffer<ArrayBuffer>], f.filename);
      } else if (input.aspect_ratio === 'auto') {
        // auto aspect ratio is only supported for i2v
        input.aspect_ratio = '16:9';
      }

      let res = await fal.subscribe(model, { input });
      let { url } = res.data.video;
      output_base64 = await fetchToBase64(url);
    } else if (service === 'h3') {
      let input: any = {
        prompt,
        duration: parseInt(duration) || 5,
        resolution: resolution || '2K',
        aspect_ratio: aspect_ratio || 'adaptive',
        enable_prompt_expansion: prompt_expansion === 'true',
        enable_safety_checker: false,
      };

      let model = 'minimax/h3/text-to-video';
      if (Array.isArray(req.files) && req.files.length > 0) {
        if (req.files.length > 9) {
          throw new Error('h3 supports at most nine images as input');
        }
        model = 'minimax/h3/reference-to-video';
        input.reference_image_urls = req.files.map(f => new File([f.buffer as Buffer<ArrayBuffer>], f.filename));
      } else if (input.aspect_ratio === 'adaptive') {
        // adaptive aspect ratio is only supported when there are references
        input.aspect_ratio = '16:9';
      }

      let res = await fal.subscribe(model, { input });
      let { url } = res.data.video;
      output_base64 = await fetchToBase64(url);
    } else if (service === 'qwen') {
      let input: any = {
        prompt,
        enhance_prompt: enhance_prompt === 'true',
        aspect_ratio: aspect_ratio || '16:9',
        go_fast: true,
        num_inference_steps: 50,
        guidance: parseFloat(guidance) || 4,
        enable_safety_checker: false,
      };
      let model = 'fal-ai/qwen-image';
      if (Array.isArray(req.files) && req.files.length > 0) {
        if (req.files.length === 1) {
          model = 'fal-ai/qwen-image-edit/image-to-image';
          let f = req.files[0];
          input.image_url = new File([f.buffer as Buffer<ArrayBuffer>], f.filename);
        } else {
          model = 'fal-ai/qwen-image-edit-plus';
          input.image_urls = req.files.map(f => new File([f.buffer as Buffer<ArrayBuffer>], f.filename));
        }
      }

      let res = await fal.subscribe(model, { input });
      let { url } = res.data.images[0];
      output_base64 = await fetchToBase64(url);
    } else if (service === 'nanobanana') {
      let input: any = {
        prompt,
        resolution: nanobanana_resolution || '1K',
      };
      let model = 'fal-ai/nano-banana-pro';
      if (Array.isArray(req.files) && req.files.length > 0) {
        model = 'fal-ai/nano-banana-pro/edit';
        input.image_urls = req.files.map(f => new File([f.buffer as Buffer<ArrayBuffer>], f.filename));
      }

      let res = await fal.subscribe(model, { input });
      let { url } = res.data.images[0];
      output_base64 = await fetchToBase64(url);
    } else {
      throw new Error(`unknown service ${service}`);
    }
    return output_base64;
  };

  let ext = videos.includes(service) ? 'mp4' : 'png';

  let settled = generate().then(
    output_base64 => {
      console.log('done');
      if (SAVE_OUTPUTS) {
        // Save the output to a file
        fs.writeFileSync(path.join(outdir, `${ts}--${ext === 'mp4' ? 'video.mp4' : 'image.png'}`), Buffer.from(output_base64, 'base64'));
      }
      return { output_base64, error: null };
    },
    e => {
      console.log(e);
      return { output_base64: null, error: e?.message ?? e?.error?.message ?? e?.toString() ?? 'unknown error' };
    },
  );

  // if the upstream API is fast, just long-poll as before; otherwise hand back an ID to poll
  let timer: NodeJS.Timeout;
  let outcome = await Promise.race([
    settled,
    new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), LONG_POLL_TIMEOUT);
    }),
  ]);
  clearTimeout(timer!);

  if (outcome != null) {
    if (outcome.error != null) {
      res.json({ error: outcome.error });
    } else {
      res.json({ b64: outcome.output_base64 });
    }
    return;
  }

  let id = crypto.randomBytes(6).toString('hex');
  results.set(id, { state: 'working', ts: Date.now(), ext });
  console.log(`slow; handing back id ${id}`);
  res.json({ id });

  settled.then(({ output_base64, error }) => {
    let old = results.get(id);
    if (old == null) return; // swept, somehow
    if (error != null) {
      results.set(id, { state: 'error', ts: old.ts, ext, error });
    } else {
      results.set(id, { state: 'done', ts: old.ts, ext, buffer: Buffer.from(output_base64!, 'base64') });
    }
  });
});

app.get('/poll/:id', (req, res) => {
  let result = results.get(req.params.id);
  if (result == null) {
    res.json({ state: 'error', error: 'no longer serving this ID' });
  } else if (result.state === 'done') {
    res.json({ state: 'done', url: `/results/${req.params.id}.${result.ext}` });
  } else if (result.state === 'error') {
    res.json({ state: 'error', error: result.error });
  } else {
    res.json({ state: 'working' });
  }
});

app.get('/results/:name', (req, res) => {
  let match = req.params.name.match(/^(?<id>[0-9a-f]{12})\.(?<ext>png|mp4)$/);
  let result = match ? results.get(match.groups!.id) : null;
  if (result == null || result.state !== 'done' || result.ext !== match!.groups!.ext) {
    res.status(404);
    res.send('not found');
    return;
  }
  res.setHeader('content-type', result.ext === 'mp4' ? 'video/mp4' : 'image/png');
  res.send(result.buffer);
});

const contentTypeToExt: Record<string, string> = {
  // @ts-expect-error
  __proto__: null,
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/ico': '.ico'
};

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
