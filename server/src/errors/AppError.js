export class AppError extends Error {
  /**
   * @param {string} code - Machine-readable error code (e.g. 'VALIDATION_ERROR', 'INVALID_CREDENTIALS')
   * @param {number} httpStatus - HTTP status code (e.g. 400, 401, 403, 404, 409, 429)
   * @param {string} [message] - Human-readable explanation
   * @param {Record<string, any>} [details] - Additional contextual details
   */
  constructor(code, httpStatus = 500, message = code, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}
