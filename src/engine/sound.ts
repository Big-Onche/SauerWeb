export interface SoundBackend {
  play(path: string, volume: number): void;
}

export class SoundSystem {
  constructor(private readonly backend: SoundBackend) {}

  // Original: src/engine/sound.cpp
  // Function: playsound()
  // Sauerbraten reference: SVN r6488
  playsound(path: string, volume = 1): void {
    this.backend.play(path, volume);
  }
}
