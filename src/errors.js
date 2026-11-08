// Помилки двох типів: проблема в запиті користувача (HarnessError)
// і проблема на боці провайдера моделі (ProviderError).

export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
  }
}

// code: auth | rate_limited | model_not_found | network | upstream | bad_response
export class ProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    Object.assign(this, extra);
  }
}
