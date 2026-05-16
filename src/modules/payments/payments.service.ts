import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { FreekassaService } from './providers/freekassa.service';
import { HeleketService } from './providers/heleket.service';
import { TonPaymentService } from './providers/ton-payment.service';
import { PaymentHealthService } from './payment-health.service';
import { FraudService } from '@/modules/fraud/fraud.service';
import {
  Payment,
  PaymentStatus,
  PaymentMethod,
  ProductType,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  withRetry,
  isRetryableError,
  withTransactionRetry,
} from '@/shared/utils';

/** Окно ожидания оплаты TON (автоотмена, проверка «истекло» в статусе). */
export const TON_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freekassaService: FreekassaService,
    private readonly heleketService: HeleketService,
    private readonly tonPaymentService: TonPaymentService,
    private readonly paymentHealthService: PaymentHealthService,
    private readonly eventEmitter: EventEmitter2,
    private readonly fraudService: FraudService,
  ) {}

  async createPayment(data: {
    user_id: string;
    user_telegram_id: string;
    recipient: string;
    recipient_username?: string;
    recipient_name?: string;
    payment_method: PaymentMethod;
    payment_system: PaymentMethod;
    product_type: ProductType;
    product_quantity: string;
    amount_rub: string;
    amount_usd: string;
    amount_crypto?: string;
    amount_ton?: string;
    crypto_currency?: string;
    usd_rate: string;
    service_markup_percent: string;
    payment_system_fee_percent: string;
    purchase_price_usd: string;
    net_profit_rub: string;
    fragment_cookie?: string;
    /** Параметр `i` Freekassa (крипто и др.); только для FREEKASSA. */
    freekassa_suggested_method_id?: number;
  }): Promise<Payment> {
    const payment = await this.prisma.payment.create({
      data: {
        user_id: data.user_id,
        user_telegram_id: data.user_telegram_id,
        recipient: data.recipient,
        recipient_username: data.recipient_username,
        recipient_name: data.recipient_name,
        payment_method: data.payment_method,
        payment_system: data.payment_system,
        product_type: data.product_type,
        product_quantity: data.product_quantity,
        amount_rub: data.amount_rub,
        amount_usd: data.amount_usd,
        amount_crypto: data.amount_crypto,
        amount_ton: data.amount_ton,
        crypto_currency: data.crypto_currency,
        usd_rate: data.usd_rate,
        service_markup_percent: data.service_markup_percent,
        payment_system_fee_percent: data.payment_system_fee_percent,
        purchase_price_usd: data.purchase_price_usd,
        net_profit_rub: data.net_profit_rub,
        fragment_cookie: data.fragment_cookie,
        status: PaymentStatus.PENDING,
      },
    });

    try {
      let externalPaymentData: any = null;

      switch (data.payment_method) {
        case PaymentMethod.FREEKASSA:
          externalPaymentData = await withRetry(
            () =>
              this.freekassaService.createPayment({
                orderId: payment.order_number.toString(),
                amountRub: parseFloat(data.amount_rub),
                suggestedMethodId: data.freekassa_suggested_method_id,
                payerEmail: `${data.user_telegram_id}@telegram.org`,
              }),
            {
              maxAttempts: 2,
              delayMs: 500,
              exponentialBackoff: false,
              shouldRetry: isRetryableError,
              onRetry: (attempt, error) => {
                this.logger.warn(
                  `Retry attempt ${attempt} for Freekassa payment ${payment.id}: ${error.message}`,
                );
              },
            },
          );
          break;

        case PaymentMethod.HELEKET:
          if (!data.amount_crypto || !data.crypto_currency) {
            throw new Error(
              'Missing required fields for Heleket payment: amount_crypto and crypto_currency',
            );
          }
          externalPaymentData = await withRetry(
            () =>
              this.heleketService.createPayment({
                order_id: payment.id,
                amount: parseFloat(data.amount_crypto),
                currency: data.crypto_currency,
              }),
            {
              maxAttempts: 2,
              delayMs: 500,
              exponentialBackoff: false,
              shouldRetry: isRetryableError,
              onRetry: (attempt, error) => {
                this.logger.warn(
                  `Retry attempt ${attempt} for Heleket payment ${payment.id}: ${error.message}`,
                );
              },
            },
          );
          break;

        case PaymentMethod.TON:
      }

      if (externalPaymentData) {
        if (!externalPaymentData.id || !externalPaymentData.url) {
          this.logger.error(
            `Invalid external payment data for ${payment.id}: missing id or url`,
            externalPaymentData,
          );
          throw new Error(
            'Invalid response from payment provider: missing payment id or url',
          );
        }

        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            external_payment_id: externalPaymentData.id,
            payment_url: externalPaymentData.url,
          },
        });

        this.paymentHealthService
          .recordSuccess(data.payment_method)
          .catch((err) =>
            this.logger.warn(`Health recordSuccess error: ${err.message}`),
          );
      }
    } catch (error) {
      this.logger.error(
        `Failed to create external payment for ${payment.id}: ${error.message}`,
        error.stack,
      );

      this.paymentHealthService
        .recordFailure(data.payment_method)
        .catch((err) =>
          this.logger.warn(`Health recordFailure error: ${err.message}`),
        );

      await this.prisma.payment
        .update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.FAILED,
            updated_at: new Date(),
          },
        })
        .catch((updateError) => {
          this.logger.error(
            `Failed to update payment ${payment.id} to FAILED status: ${updateError.message}`,
          );
        });
      throw error;
    }

    const updatedPayment = await this.prisma.payment.findUnique({
      where: { id: payment.id },
    });

    if (!updatedPayment) {
      throw new Error('Payment not found after creation');
    }

    if (
      data.payment_method !== PaymentMethod.TON &&
      !updatedPayment.payment_url
    ) {
      this.logger.error(
        `Payment ${payment.id} created without payment_url for method ${data.payment_method}`,
      );
      throw new Error('Payment URL was not generated');
    }

    return updatedPayment;
  }

  private readonly VALID_STATUS_TRANSITIONS: Record<
    PaymentStatus,
    PaymentStatus[]
  > = {
    [PaymentStatus.PENDING]: [
      PaymentStatus.PROCESSING,
      PaymentStatus.COMPLETED,
      PaymentStatus.CANCELLED,
      PaymentStatus.FAILED,
      PaymentStatus.FRAUD,
    ],
    [PaymentStatus.PROCESSING]: [
      PaymentStatus.COMPLETED,
      PaymentStatus.CANCELLED,
      PaymentStatus.FAILED,
      PaymentStatus.FRAUD,
    ],
    [PaymentStatus.COMPLETED]: [PaymentStatus.REFUNDED, PaymentStatus.FRAUD],
    [PaymentStatus.FAILED]: [PaymentStatus.PENDING, PaymentStatus.COMPLETED],
    [PaymentStatus.CANCELLED]: [PaymentStatus.COMPLETED],
    [PaymentStatus.REFUNDED]: [],
    [PaymentStatus.FRAUD]: [PaymentStatus.COMPLETED],
  };

  async updatePaymentStatus(
    paymentId: string,
    newStatus: PaymentStatus,
  ): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    const allowedTransitions =
      this.VALID_STATUS_TRANSITIONS[payment.status] || [];
    if (!allowedTransitions.includes(newStatus)) {
      this.logger.warn(
        `Invalid status transition for payment ${paymentId}: ${payment.status} -> ${newStatus}`,
      );
      throw new Error(
        `Invalid status transition from ${payment.status} to ${newStatus}`,
      );
    }

    return this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: newStatus,
        updated_at: new Date(),
      },
    });
  }

  async getPayment(paymentId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
  }

  async getPaymentByExternalId(externalId: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: { external_payment_id: externalId },
    });
  }

  async getPendingPayments(): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
      },
      orderBy: {
        created_at: 'asc',
      },
      take: 200,
    });
  }

  async getUserPayments(
    userTelegramId: string,
    limit: number = 50,
  ): Promise<(Payment & { fragment_queue: any[] })[]> {
    return this.prisma.payment.findMany({
      where: {
        user: {
          telegram_id: userTelegramId,
        },
      },
      include: {
        fragment_queue: {
          select: {
            id: true,
            status: true,
            tx_hash: true,
          },
        },
      },
      orderBy: {
        created_at: 'desc',
      },
      take: limit,
    });
  }

  async getUserPaymentsCount(userTelegramId: string): Promise<number> {
    return this.prisma.payment.count({
      where: {
        user: {
          telegram_id: userTelegramId,
        },
      },
    });
  }

  async getUserPaymentsFiltered(
    userTelegramId: string,
    filter: string,
    skip: number,
    take: number,
  ): Promise<{
    payments: (Payment & { fragment_queue: any[] })[];
    totalCount: number;
    completedCount: number;
  }> {
    const baseWhere: any = {
      user: { telegram_id: userTelegramId },
    };

    const filteredWhere: any = { ...baseWhere };
    if (filter === 'completed') {
      filteredWhere.status = PaymentStatus.COMPLETED;
    } else if (filter === 'failed') {
      filteredWhere.status = { not: PaymentStatus.COMPLETED };
    }

    const [payments, totalCount, completedCount] = await Promise.all([
      this.prisma.payment.findMany({
        where: filteredWhere,
        include: {
          fragment_queue: {
            select: { id: true, status: true, tx_hash: true },
          },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take,
      }),
      this.prisma.payment.count({ where: baseWhere }),
      this.prisma.payment.count({
        where: { ...baseWhere, status: PaymentStatus.COMPLETED },
      }),
    ]);

    return { payments, totalCount, completedCount };
  }

  async getProcessingPayments(): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: {
        status: {
          in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING],
        },
      },
      orderBy: {
        created_at: 'asc',
      },
      take: 200,
    });
  }

  async getProviderStatus(payment: Payment): Promise<string | null> {
    try {
      if (payment.payment_method === PaymentMethod.FREEKASSA) {
        if (payment.status === PaymentStatus.COMPLETED) {
          return '✅ Успешная оплата';
        }
        if (payment.status === PaymentStatus.CANCELLED) {
          return '🕐 Время ожидания оплаты истекло';
        }
        if (payment.status === PaymentStatus.FAILED) {
          return '⛔ Ошибка оплаты';
        }
        return '⌛️ Ожидание оплаты (Freekassa)';
      }

      if (payment.payment_method === PaymentMethod.HELEKET) {
        if (!payment.external_payment_id) return null;
        const status = await this.heleketService.getPaymentInfo(
          payment.external_payment_id,
        );

        const map: Record<string, string> = {
          paid: '✅ Подтверждена',
          paid_over: '✅ Подтверждена (переплата)',
          wrong_amount: '⚠️ Неверная сумма',
          process: '⏳ В ожидании',
          confirm_check: '⏳ Проверка',
          wrong_amount_waiting: '⏳ Ожидание доплаты',
          check: '⏳ Проверка',
          fail: '❌ Ошибка',
          cancel: '❌ Отменена',
          system_fail: '❌ Системная ошибка',
          refund_process: '↩️ Возврат в процессе',
          refund_fail: '↩️ Ошибка возврата',
          refund_paid: '↩️ Возврат выполнен',
        };
        return map[status] ?? `❓ ${status}`;
      }

      if (payment.payment_method === PaymentMethod.TON) {
        return await this.getTonProviderStatus(payment);
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to get provider status for payment ${payment.id} (${payment.payment_method}): ${error?.message || 'unknown error'}`,
      );
      return '⚠️ Ошибка запроса статуса у провайдера';
    }

    return null;
  }

  private formatTonAmountFromNano(nano: bigint): string {
    const n = Number(nano) / 1e9;
    if (!Number.isFinite(n)) return '0';
    const s = n.toFixed(6).replace(/\.?0+$/, '');
    return s || '0';
  }

  private async getTonProviderStatus(payment: Payment): Promise<string | null> {
    const DUST_NANO = 1000n;

    if (payment.status === PaymentStatus.COMPLETED) {
      return '✅ Успешная оплата';
    }
    if (payment.status === PaymentStatus.CANCELLED) {
      return '🕐 Время ожидания оплаты истекло';
    }
    if (payment.status === PaymentStatus.FAILED) {
      return '⛔ Ошибка оплаты';
    }
    if (payment.status === PaymentStatus.REFUNDED) {
      return '↩️ Возврат';
    }
    if (payment.status === PaymentStatus.FRAUD) {
      return '🚫 Мошенничество';
    }

    const createdAt = payment.created_at?.getTime?.() ?? 0;
    const expiredByTime = Date.now() - createdAt > TON_PAYMENT_WINDOW_MS;

    const amountStr = payment.amount_ton?.toString() || '0';

    try {
      const tonResult = await this.tonPaymentService.findTransactionWithHash(
        amountStr,
        payment.id,
      );

      if (tonResult.found && tonResult.txHash) {
        return '✅ Успешная оплата';
      }

      if (tonResult.partialAmountNano !== undefined) {
        const expectedNano = BigInt(
          payment.amount_ton
            ? Math.round(parseFloat(payment.amount_ton.toString()) * 1e9)
            : 0,
        );
        const got = tonResult.partialAmountNano;
        const shortfallNano = expectedNano > got ? expectedNano - got : 0n;
        if (shortfallNano > DUST_NANO) {
          const gotTon = this.formatTonAmountFromNano(got);
          const needTon = this.formatTonAmountFromNano(shortfallNano);
          return `⚠️ Частичная оплата: ${gotTon} TON · не хватает: ${needTon} TON`;
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `getTonProviderStatus blockchain check failed for ${payment.id}: ${err?.message}`,
      );
      return '⚠️ Не удалось проверить статус в сети TON';
    }

    if (expiredByTime) {
      return '🕐 Время ожидания оплаты истекло';
    }
    return '⏳ Ожидает оплаты';
  }

  async checkPaymentStatus(payment: Payment): Promise<PaymentStatus> {
    let isPaid = false;

    switch (payment.payment_method) {
      case PaymentMethod.HELEKET:
        if (!payment.external_payment_id) {
          return payment.status;
        }
        try {
          isPaid = await withRetry(
            () =>
              this.heleketService.checkPaymentStatus(
                payment.external_payment_id!,
              ),
            {
              maxAttempts: 2,
              delayMs: 500,
              exponentialBackoff: false,
              shouldRetry: isRetryableError,
            },
          );
        } catch (error: any) {
          this.logger.error(
            `Error checking Heleket payment ${payment.id}: ${error.message}`,
          );
          throw error;
        }
        break;

      case PaymentMethod.FREEKASSA:
        return payment.status;

      case PaymentMethod.TON: {
        try {
          const tonResult =
            await this.tonPaymentService.findTransactionWithHash(
              payment.amount_ton?.toString() || '0',
              payment.id,
            );

          if (!tonResult.found || !tonResult.txHash) {
            if (tonResult.partialAmountNano !== undefined) {
              try {
                const expectedNano = BigInt(
                  payment.amount_ton
                    ? Math.round(
                        parseFloat(payment.amount_ton.toString()) * 1e9,
                      )
                    : 0,
                );
                const shortfallNano =
                  expectedNano - tonResult.partialAmountNano;
                const DUST_THRESHOLD = 1000n;
                if (shortfallNano > DUST_THRESHOLD) {
                  const shortfallTon = (Number(shortfallNano) / 1e9).toFixed(4);
                  const actualTon = (
                    Number(tonResult.partialAmountNano) / 1e9
                  ).toFixed(4);
                  const expectedTon = (Number(expectedNano) / 1e9).toFixed(4);

                  const existingNotification =
                    await this.prisma.notificationQueue.findFirst({
                      where: {
                        payment_id: payment.id,
                        message_type: 'partial_underpayment',
                      },
                    });

                  if (!existingNotification) {
                    await this.prisma.notificationQueue.create({
                      data: {
                        user_telegram_id: payment.user_telegram_id,
                        message_type: 'partial_underpayment',
                        payment_id: payment.id,
                        message_data: {
                          order_number: payment.order_number,
                          expected_ton: expectedTon,
                          actual_ton: actualTon,
                          shortfall_ton: shortfallTon,
                          payment_id: payment.id,
                          payment_message_id: payment.payment_message_id,
                        },
                      },
                    });
                    this.logger.log(
                      `Partial underpayment for payment #${payment.order_number}: got ${actualTon} TON, need ${shortfallTon} TON more`,
                    );
                  }
                }
              } catch (notifyError: any) {
                this.logger.error(
                  `Failed to queue partial underpayment notification for payment ${payment.id}: ${notifyError.message}`,
                );
              }
            }
            break;
          }

          if (await this.tonPaymentService.isTxHashUsed(tonResult.txHash)) {
            const currentPayment = await this.prisma.payment.findUnique({
              where: { id: payment.id },
            });
            if (currentPayment?.status === PaymentStatus.COMPLETED) {
              return PaymentStatus.COMPLETED;
            }
            if (
              currentPayment?.status === PaymentStatus.CANCELLED ||
              currentPayment?.status === PaymentStatus.REFUNDED
            ) {
              return currentPayment.status;
            }
            this.logger.warn(
              `TxHash ${tonResult.txHash} already marked as used, but payment ${payment.id} status is ${currentPayment?.status}`,
            );
            break;
          }

          const updateResult = await withTransactionRetry(
            () =>
              this.prisma.$transaction(
                async (tx) => {
                  const existingWithTxHash = await tx.payment.findFirst({
                    where: {
                      provider_transaction_id: tonResult.txHash,
                    },
                  });

                  if (existingWithTxHash) {
                    if (existingWithTxHash.id === payment.id) {
                      return { success: true, alreadyDone: true };
                    }
                    this.logger.error(
                      `DUPLICATE TRANSACTION: TxHash ${tonResult.txHash} already used by payment ${existingWithTxHash.id}, rejecting for ${payment.id}`,
                    );
                    return { success: false, reason: 'duplicate' };
                  }

                  const currentPayment = await tx.payment.findUnique({
                    where: { id: payment.id },
                  });

                  if (!currentPayment) {
                    return { success: false, reason: 'not_found' };
                  }

                  if (currentPayment.status === PaymentStatus.COMPLETED) {
                    return { success: true, alreadyDone: true };
                  }

                  if (
                    currentPayment.status === PaymentStatus.CANCELLED ||
                    currentPayment.status === PaymentStatus.REFUNDED
                  ) {
                    return { success: false, reason: 'invalid_status' };
                  }

                  await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                      status: PaymentStatus.COMPLETED,
                      provider_transaction_id: tonResult.txHash,
                      external_payment_id: tonResult.txHash,
                      updated_at: new Date(),
                    },
                  });

                  return { success: true, alreadyDone: false };
                },
                {
                  timeout: 5000,
                  isolationLevel: 'ReadCommitted',
                },
              ),
            {
              maxAttempts: 3,
              delayMs: 100,
              operationName: `TON payment ${payment.id}`,
            },
          );

          if (updateResult.success) {
            const hashesToMark = tonResult.allTxHashes?.length
              ? tonResult.allTxHashes
              : tonResult.txHash
                ? [tonResult.txHash]
                : [];
            for (const hash of hashesToMark) {
              await this.tonPaymentService.markTxHashAsUsed(hash);
            }
            isPaid = true;

            if (tonResult.actualAmountNano !== undefined) {
              const expectedNano = BigInt(
                payment.amount_ton
                  ? Math.round(parseFloat(payment.amount_ton.toString()) * 1e9)
                  : 0,
              );
              const actualNano = tonResult.actualAmountNano;
              const DUST_THRESHOLD = 1000n;
              if (
                actualNano < expectedNano &&
                expectedNano - actualNano > DUST_THRESHOLD
              ) {
                const shortfallNano = expectedNano - actualNano;
                const shortfallTon = (Number(shortfallNano) / 1e9)
                  .toFixed(9)
                  .replace(/\.?0+$/, '');
                const expectedTon = (Number(expectedNano) / 1e9)
                  .toFixed(9)
                  .replace(/\.?0+$/, '');
                const actualTon = (Number(actualNano) / 1e9)
                  .toFixed(9)
                  .replace(/\.?0+$/, '');

                try {
                  const existingQueue =
                    await this.prisma.fragmentQueue.findFirst({
                      where: { payment_id: payment.id, status: 'COMPLETED' },
                    });

                  if (!existingQueue) {
                    await this.prisma.notificationQueue.create({
                      data: {
                        user_telegram_id: payment.user_telegram_id,
                        message_type: 'underpayment',
                        payment_id: payment.id,
                        message_data: {
                          order_number: payment.order_number,
                          expected_ton: expectedTon,
                          actual_ton: actualTon,
                          shortfall_ton: shortfallTon,
                          payment_message_id: payment.payment_message_id,
                          details_message_id: payment.details_message_id,
                        },
                      },
                    });
                    this.logger.log(
                      `Underpayment for payment #${payment.order_number}: expected ${expectedTon} TON, got ${actualTon} TON (short by ${shortfallTon} TON)`,
                    );
                  }
                } catch (notifyError: any) {
                  this.logger.error(
                    `Failed to queue underpayment notification for payment ${payment.id}: ${notifyError.message}`,
                  );
                }
              }
            }

            return PaymentStatus.COMPLETED;
          }
        } catch (error: any) {
          if (error.code === 'P2034') {
            this.logger.warn(
              `Transaction conflict for TON payment ${payment.id}, will retry on next cycle`,
            );
            return payment.status;
          }
          this.logger.error(
            `Error checking TON payment ${payment.id}: ${error.message}`,
          );
          throw error;
        }
        break;
      }
    }

    if (isPaid) {
      await this.updatePaymentStatus(payment.id, PaymentStatus.COMPLETED);
      return PaymentStatus.COMPLETED;
    }

    return payment.status;
  }

  async handleCompletedPayment(
    payment: Payment,
  ): Promise<{ created: boolean }> {
    try {
      await this.fraudService
        .checkConsecutiveCancellations(payment.user_telegram_id)
        .catch(() => {});

      const isInFraudList = await this.fraudService.isInFraudList(
        payment.user_telegram_id,
        payment.recipient_username || undefined,
      );

      if (isInFraudList) {
        if (payment.status === PaymentStatus.FRAUD) {
          return { created: false };
        }

        this.logger.warn(
          `Payment ${payment.id} from fraud list user ${payment.user_telegram_id} - marking as FRAUD`,
        );

        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.FRAUD, updated_at: new Date() },
        });

        this.eventEmitter.emit('fraud.detected', {
          ...payment,
          status: PaymentStatus.FRAUD,
        });
        return { created: false };
      }

      let targetUsername = payment.recipient_username;
      if (!targetUsername || targetUsername.trim() === '') {
        const buyer = await this.prisma.user.findUnique({
          where: { id: payment.user_id },
          select: { username: true },
        });
        targetUsername = buyer?.username || '';

        if (!targetUsername) {
          this.logger.error(
            `Cannot create fragment queue for payment ${payment.id}: both recipient_username and buyer username are empty`,
          );
          throw new Error('No valid username for delivery');
        }

        this.logger.log(
          `Payment ${payment.id} has no recipient_username, using buyer's username: ${targetUsername}`,
        );
      }

      const existingQueue = await this.prisma.fragmentQueue.findUnique({
        where: { payment_id: payment.id },
      });

      if (existingQueue) {
        if (existingQueue.status === 'COMPLETED') {
          this.logger.log(
            `Fragment queue item already completed for payment ${payment.id} (tx: ${existingQueue.tx_hash || 'pending'}), skipping`,
          );
          this.eventEmitter.emit('payment.completed', payment);
          return { created: false };
        }

        if (existingQueue.status === 'PROCESSING') {
          this.logger.log(
            `Fragment queue item is PROCESSING for payment ${payment.id}, skipping to avoid disrupting active send`,
          );
          this.eventEmitter.emit('payment.completed', payment);
          return { created: false };
        }

        await this.prisma.fragmentQueue.updateMany({
          where: {
            payment_id: payment.id,
            status: { in: ['PENDING', 'FAILED'] },
          },
          data: {
            status: 'PENDING',
            username: targetUsername,
            retry_count: 0,
            outbound_submitted_at: null,
            external_out_msg_hash: null,
            updated_at: new Date(),
          },
        });

        this.logger.log(
          `Fragment queue item reset to PENDING for payment ${payment.id} (was ${existingQueue.status})`,
        );
        this.eventEmitter.emit('payment.completed', payment);
        return { created: false };
      }

      await this.prisma.fragmentQueue.create({
        data: {
          user_id: payment.user_id,
          payment_id: payment.id,
          username: targetUsername,
          stars:
            payment.product_type === 'STARS'
              ? parseInt(payment.product_quantity)
              : null,
          ton:
            payment.product_type === 'TON'
              ? parseInt(payment.product_quantity)
              : null,
          premium:
            payment.product_type === 'PREMIUM'
              ? parseInt(payment.product_quantity)
              : null,
          status: 'PENDING',
          is_anon: payment.is_anonymous || false,
        },
      });

      this.logger.log(
        `Fragment queue item created for payment ${payment.id} (${payment.product_type} x${payment.product_quantity}) | user_id: ${payment.user_id}, user_telegram_id: ${payment.user_telegram_id}, recipient: ${payment.recipient_username || payment.recipient_name}`,
      );

      this.eventEmitter.emit('payment.completed', payment);
      return { created: true };
    } catch (error: any) {
      const isUniqueViolation =
        error?.code === 'P2002' ||
        error?.message?.includes('Unique constraint');
      if (isUniqueViolation) {
        this.logger.log(
          `Fragment queue item already exists for payment ${payment.id} (concurrent processing), skipping`,
        );
        return { created: false };
      }

      this.logger.error(
        `CRITICAL: Error handling completed payment ${payment.id}: ${error.message}. Payment is COMPLETED but may not be in fragment queue!`,
        error.stack,
      );
      throw error;
    }
  }

  async completePaymentWithQueue(
    paymentId: string,
    updateData: {
      provider_transaction_id?: string;
    } = {},
  ): Promise<{ payment: Payment; queueCreated: boolean } | null> {
    const preCheckPayment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!preCheckPayment) {
      this.logger.warn(`Payment ${paymentId} not found`);
      return null;
    }

    await this.fraudService
      .checkConsecutiveCancellations(preCheckPayment.user_telegram_id)
      .catch(() => {});

    return withTransactionRetry(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            const payment = await tx.payment.findUnique({
              where: { id: paymentId },
            });

            if (!payment) {
              this.logger.warn(`Payment ${paymentId} not found in transaction`);
              return null;
            }

            if (payment.status === PaymentStatus.COMPLETED) {
              this.logger.warn(
                `Payment ${paymentId} already completed, skipping duplicate`,
              );
              return null;
            }

            const allowedTransitions =
              this.VALID_STATUS_TRANSITIONS[payment.status] || [];
            if (!allowedTransitions.includes(PaymentStatus.COMPLETED)) {
              this.logger.warn(
                `Payment ${paymentId} status ${payment.status} cannot transition to COMPLETED`,
              );
              return null;
            }

            if (updateData.provider_transaction_id) {
              const existingPaymentWithTxId = await tx.payment.findFirst({
                where: {
                  provider_transaction_id: updateData.provider_transaction_id,
                  id: { not: paymentId },
                },
              });

              if (existingPaymentWithTxId) {
                this.logger.error(
                  `DUPLICATE TRANSACTION: txId ${updateData.provider_transaction_id} already used by payment ${existingPaymentWithTxId.id}`,
                );
                await tx.payment.update({
                  where: { id: paymentId },
                  data: {
                    status: PaymentStatus.FAILED,
                    updated_at: new Date(),
                  },
                });
                return null;
              }
            }

            // Сразу перед статусом: antifraud мог добавить запись в fraud_list в этом же запросе (карта/телефон).
            const isInFraudList = await this.fraudService.isInFraudList(
              payment.user_telegram_id,
              payment.recipient_username || undefined,
            );

            const updatedPayment = await tx.payment.update({
              where: { id: paymentId },
              data: {
                status: isInFraudList
                  ? PaymentStatus.FRAUD
                  : PaymentStatus.COMPLETED,
                updated_at: new Date(),
                ...(updateData.provider_transaction_id && {
                  provider_transaction_id: updateData.provider_transaction_id,
                }),
              },
            });

            let queueCreated = false;

            if (isInFraudList) {
              this.logger.warn(
                `Payment ${paymentId} from fraud list user ${updatedPayment.user_telegram_id} - marked as FRAUD`,
              );
              this.eventEmitter.emit('fraud.detected', updatedPayment);
              return { payment: updatedPayment, queueCreated: false };
            }

            try {
              let targetUsername = updatedPayment.recipient_username;
              if (!targetUsername || targetUsername.trim() === '') {
                const buyer = await tx.user.findUnique({
                  where: { id: updatedPayment.user_id },
                  select: { username: true },
                });
                targetUsername = buyer?.username || '';

                if (!targetUsername) {
                  this.logger.error(
                    `Cannot create fragment queue for payment ${paymentId}: both recipient_username and buyer username are empty`,
                  );
                  throw new Error('No valid username for delivery');
                }

                this.logger.log(
                  `Payment ${paymentId} has no recipient_username, using buyer's username: ${targetUsername}`,
                );
              }

              const existingQueue = await tx.fragmentQueue.findUnique({
                where: { payment_id: updatedPayment.id },
              });

              if (existingQueue) {
                if (existingQueue.status === 'COMPLETED') {
                  this.logger.log(
                    `Fragment queue item already completed for payment ${paymentId} (tx: ${existingQueue.tx_hash || 'pending'}), skipping`,
                  );
                } else if (existingQueue.status === 'PROCESSING') {
                  this.logger.log(
                    `Fragment queue item is PROCESSING for payment ${paymentId}, skipping to avoid disrupting active send`,
                  );
                } else {
                  await tx.fragmentQueue.update({
                    where: { payment_id: updatedPayment.id },
                    data: {
                      status: 'PENDING',
                      username: targetUsername,
                      retry_count: 0,
                      outbound_submitted_at: null,
                      external_out_msg_hash: null,
                      updated_at: new Date(),
                    },
                  });
                  this.logger.log(
                    `Fragment queue item reset to PENDING for payment ${paymentId} (was ${existingQueue.status})`,
                  );
                  queueCreated = true;
                }
              } else {
                await tx.fragmentQueue.create({
                  data: {
                    user_id: updatedPayment.user_id,
                    payment_id: updatedPayment.id,
                    username: targetUsername,
                    stars:
                      updatedPayment.product_type === 'STARS'
                        ? parseInt(updatedPayment.product_quantity)
                        : null,
                    ton:
                      updatedPayment.product_type === 'TON'
                        ? parseInt(updatedPayment.product_quantity)
                        : null,
                    premium:
                      updatedPayment.product_type === 'PREMIUM'
                        ? parseInt(updatedPayment.product_quantity)
                        : null,
                    status: 'PENDING',
                    is_anon: updatedPayment.is_anonymous || false,
                  },
                });
                queueCreated = true;
                this.logger.log(
                  `Payment ${paymentId} completed with queue item in single transaction`,
                );
              }
            } catch (queueError: any) {
              const isUniqueViolation =
                queueError?.code === 'P2002' ||
                queueError?.message?.includes('Unique constraint');
              if (isUniqueViolation) {
                this.logger.log(
                  `Fragment queue item already exists for payment ${paymentId} (concurrent webhook), skipping`,
                );
              } else {
                this.logger.error(
                  `Error creating/updating fragment queue for payment ${paymentId}: ${queueError.message}`,
                );
                throw queueError;
              }
            }

            return { payment: updatedPayment, queueCreated };
          },
          {
            timeout: 5000,
            isolationLevel: 'ReadCommitted',
          },
        ),
      {
        maxAttempts: 3,
        delayMs: 100,
        operationName: `completePaymentWithQueue ${paymentId}`,
      },
    );
  }

  async fixEmptyUsernamesInQueue(): Promise<{
    found: number;
    fixed: number;
    failed: number;
    details: Array<{
      id: string;
      orderNumber: number | null;
      status: string;
      targetUsername: string | null;
    }>;
  }> {
    this.logger.log('Starting to fix empty usernames in fragment queue...');

    const emptyUsernameItems = await this.prisma.fragmentQueue.findMany({
      where: {
        username: '',
        status: {
          in: ['PENDING', 'PROCESSING', 'FAILED'],
        },
      },
      include: {
        user: {
          select: {
            username: true,
            telegram_id: true,
          },
        },
        payment: {
          select: {
            id: true,
            order_number: true,
            recipient_username: true,
          },
        },
      },
      take: 500,
    });

    this.logger.log(
      `Found ${emptyUsernameItems.length} items with empty username`,
    );

    let fixed = 0;
    let failed = 0;
    const details: Array<{
      id: string;
      orderNumber: number | null;
      status: string;
      targetUsername: string | null;
    }> = [];

    for (const item of emptyUsernameItems) {
      let targetUsername: string | null = null;

      if (
        item.payment?.recipient_username &&
        item.payment.recipient_username.trim() !== ''
      ) {
        targetUsername = item.payment.recipient_username.trim();
      } else if (item.user?.username && item.user.username.trim() !== '') {
        targetUsername = item.user.username.trim();
      }

      if (targetUsername) {
        await this.prisma.fragmentQueue.update({
          where: { id: item.id },
          data: {
            username: targetUsername,
            status: 'PENDING',
            outbound_submitted_at: null,
            external_out_msg_hash: null,
            updated_at: new Date(),
          },
        });

        this.logger.log(
          `Fixed queue item ${item.id} (order #${item.payment?.order_number || 'N/A'}): username set to "${targetUsername}"`,
        );

        details.push({
          id: item.id,
          orderNumber: item.payment?.order_number || null,
          status: 'fixed',
          targetUsername,
        });
        fixed++;
      } else {
        this.logger.error(
          `Cannot fix queue item ${item.id} (order #${item.payment?.order_number || 'N/A'}): no valid username found`,
        );

        details.push({
          id: item.id,
          orderNumber: item.payment?.order_number || null,
          status: 'failed',
          targetUsername: null,
        });
        failed++;
      }
    }

    this.logger.log(
      `Fix complete: ${fixed} fixed, ${failed} failed, ${emptyUsernameItems.length} total`,
    );

    return {
      found: emptyUsernameItems.length,
      fixed,
      failed,
      details,
    };
  }
}
