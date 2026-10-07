/**
 * Custom error classes for API
 */

class ApiError extends Error {
  constructor(message, statusCode, code = null, hint = null) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.hint = hint;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      success: false,
      error: this.message,
      code: this.code,
      hint: this.hint,
    };
  }
}

class BadRequestError extends ApiError {
  constructor(message, code = "BAD_REQUEST", hint = null) {
    super(message, 400, code, hint);
    this.name = "BadRequestError";
  }
}

class ValidationError extends ApiError {
  constructor(errors) {
    super("Validation failed", 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
    this.errors = errors;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      errors: this.errors,
    };
  }
}

class InternalError extends ApiError {
  constructor(message = "Internal server error") {
    super(message, 500, "INTERNAL_ERROR", "Please try again later");
    this.name = "InternalError";
  }
}

module.exports = {
  ApiError,
  BadRequestError,
  ValidationError,
  InternalError,
};
