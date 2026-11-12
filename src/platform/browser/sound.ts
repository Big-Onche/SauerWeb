import type { SoundBackend, SoundSource } from "../../engine/sound";
import { packageAssetUrl } from "../../assets/TextureResolver";

export class BrowserSoundBackend implements SoundBackend {
  private context?: AudioContext;

  play(path: string, loops: number): SoundSource | undefined {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return undefined;
    const url = packageAssetUrl(path);
    if (!url) return undefined;
    const audio = new Audio(url);
    audio.loop = loops < 0;
    const context = this.context ??= new AudioContext();
    const source = context.createMediaElementSource(audio), gain = context.createGain(), panner = context.createStereoPanner();
    source.connect(gain).connect(panner).connect(context.destination);
    const handle = new BrowserSoundSource(audio, gain, panner);
    void context.resume().then(() => audio.play()).catch(() => handle.stop());
    return handle;
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
