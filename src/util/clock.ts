// Injectable clock so scheduler and recovery tests never wait in real time.

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

export function toIso(d: Date): string {
  return d.toISOString();
}
