export interface LoadingProgressUpdate {
  fraction: number;
  text: string;
  detail?: string;
}

export type LoadingProgressReporter = (update: LoadingProgressUpdate) => void;

export class LoadingProgress {
  private completedWeight = 0;
  private readonly totalWeight: number;

  constructor(private readonly report: LoadingProgressReporter, private readonly stages: readonly number[]) {
    this.totalWeight = stages.reduce((sum, weight) => sum + weight, 0);
  }

  stage(index: number, text: string): (fraction: number, detail?: string) => void {
    const preceding = this.stages.slice(0, index).reduce((sum, weight) => sum + weight, 0);
    const weight = this.stages[index] ?? 0;
    return (fraction, detail) => {
      const bounded = Math.min(1, Math.max(0, fraction));
      this.completedWeight = Math.max(this.completedWeight, preceding + weight * bounded);
      this.report({ fraction: Math.min(0.999, this.completedWeight / this.totalWeight), text, detail });
    };
  }

  complete(text = "ready"): void {
    this.completedWeight = this.totalWeight;
    this.report({ fraction: 1, text });
  }
}
