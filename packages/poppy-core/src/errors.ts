/** An OAuth-style protocol error: an error code plus the HTTP status the company returns. */
export class PoppyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(code: string, status: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PoppyError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
