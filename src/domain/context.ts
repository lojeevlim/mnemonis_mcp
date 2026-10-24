/** Injected clock + id generator keep the domain deterministic and testable. */
export interface DomainContext {
  now(): string;
  newId(prefix: string): string;
}

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** Deterministic context: ids `${prefix}_${n}`, clock advances `stepMs` per call. */
export function createSequentialContext(
  start = "2026-01-01T00:00:00.000Z",
  stepMs = 1000,
): DomainContext {
  let counter = 0;
  let time = Date.parse(start);
  return {
    now() {
      const iso = new Date(time).toISOString();
      time += stepMs;
      return iso;
    },
    newId(prefix) {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}
