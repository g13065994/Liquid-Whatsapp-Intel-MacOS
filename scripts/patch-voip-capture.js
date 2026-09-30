const fs = require('fs')
const path = require('path')

function patch(file, replacements, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    if (optional) {
      console.warn('[Liquid WhatsApp] Optional VoIP file not found, skipping: ' + file)
      return false
    }
    throw new Error('VoIP file not found: ' + file)
  }
  let text = fs.readFileSync(file, 'utf8')
  let changed = false
  for (const [from, to] of replacements) {
    if (!text.includes(from)) continue
    if (!text.includes(to)) {
      text = text.replace(from, to)
      changed = true
    }
  }
  if (changed) fs.writeFileSync(file, text)
  return changed
}

const baileysRoot = path.dirname(require.resolve('@innovatorssoft/baileys/package.json'))
const ffmpegImport = 'import { createRequire } from "node:module";\\nconst require = createRequire(import.meta.url);\\nconst FFMPEG_BIN = require("ffmpeg-static") || "ffmpeg";\\n'

const audio = path.join(baileysRoot, 'lib', 'Voip', 'audio-feeder.mjs')
const video = path.join(baileysRoot, 'lib', 'Voip', 'video-feeder.mjs')
const engine = path.join(baileysRoot, 'lib', 'Voip', 'wasm-engine.mjs')
const voip = path.join(baileysRoot, 'lib', 'Voip', 'index.mjs')

patch(audio, [
  ['import { spawn } from "node:child_process";', 'import { spawn } from "node:child_process";\\n' + ffmpegImport],
  ['if (resolvedSource !== "silence" && !resolvedSource.startsWith("lavfi:")) {', 'if (resolvedSource !== "silence" && !resolvedSource.startsWith("lavfi:") && !resolvedSource.startsWith("microphone:")) {'],
  ['this.#proc = spawn("ffmpeg", [', 'this.#proc = spawn(FFMPEG_BIN, ['],
  ['if (this.source.startsWith("lavfi:")) {\\n            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];\\n        }',
   'if (this.source.startsWith("lavfi:")) {\\n            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];\\n        }\\n        if (this.source.startsWith("microphone:")) {\\n            const device = this.source.slice("microphone:".length) || "0";\\n            if (process.platform === "darwin") return ["-f", "avfoundation", "-i", ":" + device];\\n            return ["-f", "pulse", "-i", device];\\n        }']
])

patch(video, [
  ['const FFMPEG_BIN = "ffmpeg";', ffmpegImport + 'const FFMPEG_BIN = require("ffmpeg-static") || "ffmpeg";'],
  ['if (!resolvedSource.startsWith("lavfi:")) {', 'if (!resolvedSource.startsWith("lavfi:") && !resolvedSource.startsWith("camera:")) {'],
  ['this.#proc = spawn(FFMPEG_BIN, args, {', 'this.#proc = spawn(FFMPEG_BIN, args, {'],
  ['if (this.source.startsWith("lavfi:")) {\\n            args.push("-f", "lavfi", "-re", "-i", this.source.slice(6));\\n        }',
   'if (this.source.startsWith("lavfi:")) {\\n            args.push("-f", "lavfi", "-re", "-i", this.source.slice(6));\\n        }\\n        else if (this.source.startsWith("camera:")) {\\n            const device = this.source.slice("camera:".length) || "0";\\n            if (process.platform === "darwin") {\\n                args.push("-f", "avfoundation", "-framerate", String(this.fps), "-video_size", this.width + "x" + this.height, "-i", device + ":none");\\n            } else {\\n                args.push("-f", "v4l2", "-framerate", String(this.fps), "-video_size", this.width + "x" + this.height, "-i", device);\\n            }\\n        }']
], { optional: true })

console.log('[Liquid WhatsApp] VoIP capture patch ready')

patch(engine, [
  ['else if (callbackName === "onCallEvent") {',
   'else if (callbackName === "onVideoFrameWasmToJs") {\\n            callbacks.onVideoFrame?.(data);\\n        }\\n        else if (callbackName === "onCallEvent") {']
])

patch(voip, [
  ['onAudioPlaybackData: (audioData) => this.#handleAudioPlayback(audioData, callId),',
   'onAudioPlaybackData: (audioData) => this.#handleAudioPlayback(audioData, callId),\\n                onVideoFrame: (frame) => this.#handleVideoPlayback(frame, callId),'],
  ['    #handleAudioPlayback = (audioData, callId) => {',
   '    #handleVideoPlayback = (frame, callId) => {\\n        if (callId) {\\n            const call = this.#activeCalls.get(callId);\\n            if (call && !call.ended) call.emit("video", frame);\\n        }\\n    };\\n\\n    #handleAudioPlayback = (audioData, callId) => {']
])
