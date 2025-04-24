# Simple DALL-E/gpt-image-1 UI

A simple static webpage to wrap OpenAI's image-generating gpt-image-1 API. You can dig the DALL-E wrapper out of the commit history if you like the old one better.

![screenshot](./screenshot.png)

## Deploying

Ensure you have a reasonably recent version of node installed. Then

```sh
npm ci
node run.mts
```

If you are using a version of node prior to 23.6.0, you will likely need to include `--experimental-strip-types` after the `node` command.


## Implementation details

History is stored in the [origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).
