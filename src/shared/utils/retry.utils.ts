export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  exponentialBackoff?: boolean;

  jitter?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
  shouldRetry?: (error: Error) => boolean;
}

const defaultOptions: Required<Omit<RetryOptions, 'onRetry' | 'shouldRetry'>> =
  {
    maxAttempts: 3,
    delayMs: 1000,
    exponentialBackoff: true,
    jitter: false,
  };

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: Error;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (opts.shouldRetry && !opts.shouldRetry(error)) {
        throw error;
      }

      if (attempt === opts.maxAttempts) {
        throw error;
      }

      if (opts.onRetry) {
        opts.onRetry(attempt, error);
      }

      let delay = opts.exponentialBackoff
        ? opts.delayMs * Math.pow(2, attempt - 1)
        : opts.delayMs;

      if (opts.jitter) {
        delay += Math.random() * delay * 0.5;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

export function createRetryWrapper(defaultOptions: RetryOptions) {
  return <T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> => {
    return withRetry(fn, { ...defaultOptions, ...options });
  };
}

export function isRetryableError(error: any): boolean {
  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ECONNREFUSED'
  ) {
    return true;
  }

  if (error.response?.status) {
    const status = error.response.status;

    return status === 429 || (status >= 500 && status < 600);
  }

  if (error.code === 'P2034' || error.code === 'P2024') {
    return true;
  }

  return false;
}

export function isBlockchainApiRetryable(error: any): boolean {
  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'EPIPE' ||
    error.code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const status =
    error.response?.status || error.status || error.statusCode || 0;
  if (status === 429 || (status >= 500 && status < 600)) {
    return true;
  }

  const message = (error.message || '').toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('lite server') ||
    message.includes('not ready') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('getaddrinfo')
  ) {
    return true;
  }

  return false;
}
