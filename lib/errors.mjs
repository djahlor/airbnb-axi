export class AirbnbAxiError extends Error {
  constructor(message, { code = "AIRBNB_AXI_ERROR", exitCode = 1, details, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return {
      error: {
        name: this.name,
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class InputError extends AirbnbAxiError {
  constructor(message, options = {}) {
    super(message, { code: "INVALID_INPUT", exitCode: 2, ...options });
  }
}

export class SchemaError extends AirbnbAxiError {
  constructor(message, options = {}) {
    super(message, { code: "MALFORMED_SCHEMA", exitCode: 3, ...options });
  }
}

export class AccessDeniedError extends AirbnbAxiError {
  constructor(message, options = {}) {
    super(message, { code: "ACCESS_DENIED", exitCode: 4, ...options });
  }
}

export class TimeoutError extends AirbnbAxiError {
  constructor(message, options = {}) {
    super(message, { code: "TIMEOUT", exitCode: 5, ...options });
  }
}

export class RobotsDeniedError extends AirbnbAxiError {
  constructor(message, options = {}) {
    super(message, { code: "ROBOTS_DENIED", exitCode: 6, ...options });
  }
}

export class PartialPaginationError extends AirbnbAxiError {
  constructor(message, options = {}) {
    super(message, { code: "PARTIAL_PAGINATION", exitCode: 7, ...options });
  }
}
