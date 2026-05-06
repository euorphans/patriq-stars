import { Logger } from '@nestjs/common';

const logger = new Logger('TransactionRetry');

export async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    operationName?: string;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 100,
    operationName = 'transaction',
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      const isDeadlock =
        error.code === 'P2034' ||
        error.message?.includes('deadlock') ||
        error.message?.includes('write conflict');

      if (!isDeadlock) {
        throw error;
      }

      if (attempt === maxAttempts) {
        logger.error(
          `${operationName}: Max retry attempts (${maxAttempts}) reached after deadlock`,
        );
        throw error;
      }

      const backoffDelay =
        delayMs * Math.pow(2, attempt - 1) + Math.random() * 100;

      logger.warn(
        `${operationName}: Deadlock detected on attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(backoffDelay)}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, backoffDelay));
    }
  }

  throw new Error(`${operationName}: Unexpected retry loop exit`);
}

export function isDeadlockError(error: any): boolean {
  return (
    error?.code === 'P2034' ||
    error?.message?.includes('deadlock') ||
    error?.message?.includes('write conflict') ||
    error?.message?.includes('Transaction failed')
  );
}
