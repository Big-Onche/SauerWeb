import type { SoundBackend } from "../../engine/sound";
import { packageAssetUrl } from "../../assets/TextureResolver";

export class BrowserSoundBackend implements SoundBackend {
  play(path: string, volume: number): void {
    const url = packageAssetUrl(path);
    if (!url) return;
    const audio = new Audio(url);
    audio.volume = volume;
    void audio.play().catch(() => undefined);
  }
}
