import { packageAssetUrl } from "../../assets/TextureResolver";

const MUSIC_VOLUME_KEY = "sauerweb.music-volume";
const DEFAULT_MUSIC_VOLUME = 60;
const TRACKS = Array.from({ length: 8 }, (_, index) => `fanatic/${index + 1}.ogg`);

export function loadMusicVolume(): number {
  try {
    return sanitizeVolume(Number(localStorage.getItem(MUSIC_VOLUME_KEY) ?? DEFAULT_MUSIC_VOLUME));
  } catch {
    return DEFAULT_MUSIC_VOLUME;
  }
}

export function saveMusicVolume(volume: number): number {
  const sanitized = sanitizeVolume(volume);
  try { localStorage.setItem(MUSIC_VOLUME_KEY, String(sanitized)); } catch { /* The in-memory volume remains usable without storage. */ }
  return sanitized;
}

class MusicPlayer {
  private readonly audio = new Audio();
  private track = -1;
  private wanted = false;

  constructor() {
    this.audio.preload = "auto";
    this.audio.volume = loadMusicVolume() / 100;
    this.audio.addEventListener("ended", () => {
      if (this.wanted) this.playNext();
    });
  }

  playMenu(): void {
    this.wanted = true;
    if (this.track < 0) this.playNext();
    else if (this.audio.paused) this.tryPlay();
  }

  playMapLoadingMusic(): void {
    this.wanted = true;
    this.playNext();
  }

  resumeAfterUserGesture(): void {
    if (!this.wanted) this.wanted = true;
    if (this.track < 0) this.playNext();
    else this.tryPlay();
  }

  setVolume(volume: number): void {
    const sanitized = saveMusicVolume(volume);
    this.audio.volume = sanitized / 100;
    if (sanitized > 0 && this.wanted && this.audio.paused) this.tryPlay();
  }

  private playNext(): void {
    const next = this.randomTrack();
    this.track = next;
    this.audio.src = packageAssetUrl(TRACKS[next]) ?? "";
    this.tryPlay();
  }

  private randomTrack(): number {
    if (TRACKS.length < 2 || this.track < 0) return Math.floor(Math.random() * TRACKS.length);
    const next = Math.floor(Math.random() * (TRACKS.length - 1));
    return next >= this.track ? next + 1 : next;
  }

  private tryPlay(): void {
    void this.audio.play().catch(() => {
      // Browser autoplay policies are retried from the disclaimer confirmation or another menu interaction.
    });
  }
}

function sanitizeVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.round(Math.min(100, Math.max(0, volume))) : DEFAULT_MUSIC_VOLUME;
}

export const musicPlayer = new MusicPlayer();
