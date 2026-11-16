export class ServiceFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceFailure";
    this.code = code;
  }
}

export function serviceFailureCode(error: unknown): string | undefined {
  if (error instanceof ServiceFailure) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "request_id_conflict") {
    return "request_id_conflict";
  }
  return undefined;
}
