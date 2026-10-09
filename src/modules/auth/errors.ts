export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export class AuthorizationError extends HttpError {
  constructor(status: 401 | 403 = 401, message = "Inicia sesión para continuar.") {
    super(status, status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message);
    this.name = "AuthorizationError";
  }
}
