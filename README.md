# slice-studio

A local editor for Chinese spoken video. One long recording goes in. Short clips come out. The video stays on your machine.

## What it does

1. **Subtitles.** Use an SRT if you have one. Otherwise transcribe locally.
2. **Highlights.** Mark the parts worth cutting out.
3. **Voice.** Separate the voice from the rest of the audio.
4. **Sentences.** Keep or drop each line.
5. **Music.** Add background music.
6. **Export.** Write a finished video and a package of the clip.

Highlights, sentence choices, and music mood can start from an AI draft. You can do all three by hand.

## Run

Windows, Node 22.18 or newer.

```bash
npm install
npm run build
npm start
```

This repository is the source. The bundled runtimes, model weights, and music library are not included. A step that needs one of them will not run until that piece is present. On a machine that already has them, `npm run pack` builds a portable folder.
