import type { SoundBackend, SoundSource } from "../../engine/sound";
import { packageAssetUrl } from "../../assets/TextureResolver";

export class BrowserSoundBackend implements SoundBackend {
  private static readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private context?: AudioContext;

  static async preload(paths: readonly string[], progress?: (complete: number, total: number, path: string) => void): Promise<void> {
    if (!paths.length) return;
    const context = new AudioContext();
    let complete = 0;
    try {
      await Promise.all(paths.map(async (path) => {
        await this.buffer(path, context);
        progress?.(++complete, paths.length, path);
      }));
    } finally {
      void context.close();
    }
  }

  private static buffer(path: string, context: BaseAudioContext): Promise<AudioBuffer> {
    let buffer = this.buffers.get(path);
    if (!buffer) {
      buffer = fetch(packageAssetUrl(path)!, { cache: "force-cache" }).then(async (response) => {
        if (!response.ok) throw new Error(`Could not preload sound ${path} (${response.status}).`);
        return context.decodeAudioData(await response.arrayBuffer());
      });
      this.buffers.set(path, buffer);
      buffer.catch(() => this.buffers.delete(path));
    }
    return buffer;
  }

  play(path: string, loops: number): SoundSource | undefined {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return undefined;
    const url = packageAssetUrl(path);
    if (!url) return undefined;
    const context = this.context ??= new AudioContext();
    const decoded = BrowserSoundBackend.buffers.get(path);
    if (decoded) {
      const handle = new BrowserBufferSoundSource(context);
      void context.resume().then(async () => handle.start(await decoded, loops < 0)).catch(() => handle.stop());
      return handle;
    }
    const audio = new Audio(url);
    audio.loop = loops < 0;
    const source = context.createMediaElementSource(audio), gain = context.createGain(), panner = context.createStereoPanner();
    source.connect(gain).connect(panner).connect(context.destination);
    const handle = new BrowserSoundSource(audio, gain, panner);
    void context.resume().then(() => audio.play()).catch(() => handle.stop());
    return handle;
  }
}

class BrowserBufferSoundSource implements SoundSource {
  private source?: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly panner: StereoPannerNode;
  private stopped = false;

  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    this.panner = context.createStereoPanner();
    this.gain.connect(this.panner).connect(context.destination);
  }

  get playing(): boolean { return !this.stopped; }

  start(buffer: AudioBuffer, loop: boolean): void {
    if (this.stopped) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(this.gain);
    source.onended = () => { if (!source.loop) this.stopped = true; };
    this.source = source;
    source.start();
  }

  update(volume: number, pan: number): void {
    this.gain.gain.value = volume;
    this.panner.pan.value = pan;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.source?.stop(); } catch { /* The source may still be waiting for its decoded buffer. */ }
    this.source?.disconnect();
    this.gain.disconnect();
    this.panner.disconnect();
  }
}

class BrowserSoundSource implements SoundSource {
  private stopped = false;

  constructor(private readonly audio: HTMLAudioElement, private readonly gain: GainNode, private readonly panner: StereoPannerNode) {}

  get playing(): boolean { return !this.stopped && !this.audio.ended; }

  update(volume: number, pan: number): void {
    this.gain.gain.value = volume;
    this.panner.pan.value = pan;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.gain.disconnect();
    this.panner.disconnect();
  }
}
