export class GateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
}
