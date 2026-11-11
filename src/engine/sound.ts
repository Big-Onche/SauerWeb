export interface SoundBackend {
  play(path: string, volume: number): void;
}

export class SoundSystem {
  constructor(private readonly backend: SoundBackend) {}

  // Original: src/engine/sound.cpp
  // Function: playsound()
  // Sauerbraten reference: 77dab9772147fc8e6861578e0f767204d9daca5a
  playsound(path: string, volume = 1): void {
    this.backend.play(path, volume);
  }
}
