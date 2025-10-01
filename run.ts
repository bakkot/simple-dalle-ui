import * as fs from 'node:fs';
import * as path from 'node:path';
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
  let { prompt, ts, service, user, fps, duration, resolution, aspect_ratio, camera_fixed, input_fidelity, enhance_prompt, guidance, prompt_upsampling } = req.body;
  if (!ALLOWED_USERS.includes(user)) {
    res.status(403);
    res.send('unknown user');
    return;
  }
  console.log(`working (${service})...`);

  if (SAVE_OUTPUTS) {
    fs.writeFileSync(path.join(outdir, `${ts}--prompt.txt`), prompt, 'utf8');
    let settingsText = `user: ${user}\nservice: ${service}\n`;
    if (service === 'openai' && input_fidelity) {
      settingsText += `input_fidelity: ${input_fidelity}\n`;
    } else if (service === 'seedance') {
      settingsText += `fps: ${fps}\nduration: ${duration}\nresolution: ${resolution}\naspect_ratio: ${aspect_ratio}\ncamera_fixed: ${camera_fixed}\n`;
    } else if (service === 'wan') {
      settingsText += `resolution: ${resolution}\naspect_ratio: ${aspect_ratio}\n`;
    } else if (service === 'qwen') {
      settingsText += `aspect_ratio: ${aspect_ratio}\n`;
      settingsText += `guidance: ${guidance}\n`;
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

  let output_base64: string;
  try {
    if (service === 'openai') {
      let res;
      if (Array.isArray(req.files) && req.files.length > 0) {
        let editParams: any = {
          model: 'gpt-image-1',
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
          model: 'gpt-image-1',
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
        input.image_url = new File([f.buffer], f.filename);
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
        input.image_url = new File([f.buffer], f.filename);
      } else if (input.aspect_ratio === 'auto') {
        // auto aspect ratio is only supported for i2v
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
          input.image_url = new File([f.buffer], f.filename);
        } else {
          model = 'fal-ai/qwen-image-edit-plus';
          input.image_urls = req.files.map(f => new File([f.buffer], f.filename));
        }
      }

      let res = await fal.subscribe(model, { input });
      let { url } = res.data.images[0];
      output_base64 = await fetchToBase64(url);
    } else {
      throw new Error(`unknown service ${service}`);
    }
  } catch (e) {
    console.log(e);
    // @ts-expect-error
    res.json({ error: e?.message ?? e?.error?.message ?? e?.toString() ?? 'unknown error' });
    return;
  }

  console.log('done');

  if (SAVE_OUTPUTS) {
    // Save the output to a file
    let filename = service === 'seedance' ? `${ts}--video.mp4` : `${ts}--image.png`;
    fs.writeFileSync(path.join(outdir, filename), Buffer.from(output_base64, 'base64'));
  }

  res.json({ b64: output_base64 });
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
