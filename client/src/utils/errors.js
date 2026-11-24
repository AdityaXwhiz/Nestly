/**
 * Error-code to user-friendly message map (Change #11).
 * Maps API operational error codes to human-readable explanations,
 * including requestId formatting for support traceability.
 */
const ERROR_CODE_MESSAGES = {
  INVALID_CREDENTIALS: 'The email or password you entered is incorrect.',
  EMAIL_ALREADY_EXISTS: 'An account with this email already exists.',
  SESSION_EXPIRED: 'Your session has expired. Please log in again.',
  UNAUTHORIZED: 'Please log in to continue.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  NOT_FOUND: 'The requested resource was not found.',
  VALIDATION_ERROR: 'Please check your inputs and try again.',
  ITEM_INVALID: 'One or more items in your order are unavailable or have changed.',
  RESOURCE_CONFLICT: 'This time slot or date is already reserved. Please choose different dates.',
  RESOURCE_BUSY: 'High booking demand for this item right now. Please try again in a moment.',
  HOLD_EXPIRED: 'Your reservation hold has expired. Please review and place a new hold to pay.',
  HOLD_EXPIRING_SOON: 'Your reservation hold is expiring shortly. Please complete payment.',
  ORDER_NOT_HOLDABLE: 'This order cannot be placed on hold in its current state.',
  PAYMENT_ALREADY_EXISTS: 'A payment is already being processed for this order.',
  PAYMENT_FAILED: 'Payment could not be completed. Please check your payment details or try again.',
  IDEMPOTENCY_CONFLICT: 'A request with this key is already being processed. Please wait a moment.',
  RATE_LIMITED: 'Too many requests. Please wait a moment before trying again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Please try again shortly.',
};

/**
 * Format an API error into a friendly message for users,
 * including requestId when available.
 * @param {Error|{status?: number, code?: string, requestId?: string, message?: string}} error
 * @returns {string}
 */
export function getFriendlyErrorMessage(error) {
  if (!error) return 'An unexpected error occurred.';

  const code = error.code;
  let baseMsg = ERROR_CODE_MESSAGES[code] || error.message || 'An unexpected error occurred. Please try again.';

  if (error.requestId) {
    baseMsg += ` (Reference: ${error.requestId.slice(0, 8)})`;
  }

  return baseMsg;
}
