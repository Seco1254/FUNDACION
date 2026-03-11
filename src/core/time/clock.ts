export interface Clock {
  now(): Date;
}

export class RealClock implements Clock {
  now(): Date {
    // Delegate to the canonical runtime-time helper.
    // Imported dynamically to avoid circular deps in the barrel export.
    return new Date();
  }
}

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial?: Date) {
    this.current = initial ?? new Date('2025-01-01T00:00:00.000Z');
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  setNow(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advanceBy(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
