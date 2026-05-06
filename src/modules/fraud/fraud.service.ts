import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { ProductType } from '@prisma/client';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { SettingsService } from '@/modules/settings/settings.service';

const MAX_UNIQUE_PHONES_BEFORE_FRAUD = 2;
const MAX_UNIQUE_CARDS_BEFORE_FRAUD = 2;
const MAX_CONSECUTIVE_CANCELLED_ORDERS = 3;

/** Aurapay иногда присылает в payer_details только последние 4 цифры — для БД и UI единый вид. */
export function normalizePaymentCardMask(raw: string): string {
  const t = raw.trim();
  if (/^\d{4}$/.test(t)) {
    return `**** **** **** ${t}`;
  }
  return t;
}

/** Ключ «физической» карты: первые 6 + последние 4 цифр PAN, либо только :LAST4 если длинной маски нет. */
function physicalCardGroupKey(mask: string): string {
  const d = mask.replace(/\D/g, '');
  if (d.length >= 10) {
    return `${d.slice(0, 6)}:${d.slice(-4)}`;
  }
  if (d.length === 4) {
    return `:${d}`;
  }
  return `u:${mask.trim()}`;
}

/** Сливает группу :9077 с 220220:9077 (одна карта, разный формат от провайдера). */
function mergeCardMaskGroups(
  masks: string[],
): Map<string, string[]> {
  const normalized = masks.map((m) => normalizePaymentCardMask(m));
  const groups = new Map<string, string[]>();
  for (const m of normalized) {
    const k = physicalCardGroupKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(m);
  }
  for (const id of [...groups.keys()]) {
    if (!id.startsWith(':')) continue;
    const last4 = id.slice(1);
    for (const id2 of groups.keys()) {
      if (id2 !== id && id2.endsWith(`:${last4}`) && id2.length > id.length) {
        groups.set(id2, [...groups.get(id2)!, ...groups.get(id)!]);
        groups.delete(id);
        break;
      }
    }
  }
  return groups;
}

@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

  async addToFraudList(data: {
    telegram_id?: string;
    username?: string;
    reason?: string;
    added_by: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      if (!data.telegram_id && !data.username) {
        return {
          success: false,
          message: 'Необходимо указать либо ID пользователя, либо username',
        };
      }

      const existing = await this.prisma.fraudList.findFirst({
        where: {
          OR: [{ telegram_id: data.telegram_id }, { username: data.username }],
        },
      });

      if (existing) {
        return {
          success: false,
          message: 'Пользователь уже находится в списке мошенников',
        };
      }

      await this.prisma.fraudList.create({
        data: {
          telegram_id: data.telegram_id,
          username: data.username,
          reason: data.reason,
          added_by: data.added_by,
        },
      });

      if (!data.added_by.startsWith('system:') && data.telegram_id) {
        await this.prisma.fraudWhitelist
          .deleteMany({ where: { telegram_id: data.telegram_id } })
          .catch(() => {});
      }

      this.logger.log(
        `User ${data.telegram_id || data.username} added to fraud list by ${data.added_by}`,
      );

      this.notifyFraudDetected(data).catch((err) =>
        this.logger.error(`Failed to send fraud notification: ${err.message}`),
      );

      return {
        success: true,
        message: 'Пользователь добавлен в список мошенников',
      };
    } catch (error: any) {
      this.logger.error(`Error adding to fraud list: ${error.message}`);
      return {
        success: false,
        message: `Ошибка: ${error.message}`,
      };
    }
  }

  async removeFromFraudList(
    fraudId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const entry = await this.prisma.fraudList.findUnique({
        where: { id: fraudId },
      });

      await this.prisma.fraudList.delete({
        where: { id: fraudId },
      });

      if (entry?.telegram_id) {
        await this.prisma.fraudWhitelist.upsert({
          where: { telegram_id: entry.telegram_id },
          update: { added_by: 'admin:manual_unban' },
          create: {
            telegram_id: entry.telegram_id,
            added_by: 'admin:manual_unban',
          },
        });
        this.logger.log(
          `User ${entry.telegram_id} added to whitelist after manual removal from fraud list`,
        );
      } else if (entry?.username) {
        const user = await this.prisma.user.findFirst({
          where: { username: entry.username },
          select: { telegram_id: true },
        });
        if (user?.telegram_id) {
          await this.prisma.fraudWhitelist.upsert({
            where: { telegram_id: user.telegram_id },
            update: { added_by: 'admin:manual_unban' },
            create: {
              telegram_id: user.telegram_id,
              added_by: 'admin:manual_unban',
            },
          });
          this.logger.log(
            `User ${user.telegram_id} whitelisted after fraud removal by username @${entry.username}`,
          );
        }
      }

      this.logger.log(`Removed fraud entry ${fraudId} from list`);

      return {
        success: true,
        message:
          'Пользователь удален из списка мошенников и добавлен в белый список',
      };
    } catch (error: any) {
      this.logger.error(`Error removing from fraud list: ${error.message}`);
      return {
        success: false,
        message: `Ошибка: ${error.message}`,
      };
    }
  }

  async isInWhitelist(telegramId: string): Promise<boolean> {
    try {
      const found = await this.prisma.fraudWhitelist.findUnique({
        where: { telegram_id: telegramId },
      });
      return !!found;
    } catch {
      return false;
    }
  }

  async isInFraudList(
    telegram_id: string,
    username?: string,
  ): Promise<boolean> {
    try {
      const found = await this.prisma.fraudList.findFirst({
        where: {
          OR: [{ telegram_id }, { username: username?.replace('@', '') }],
        },
      });

      return !!found;
    } catch (error: any) {
      this.logger.error(`Error checking fraud list: ${error.message}`);
      return false;
    }
  }

  async getFraudBlockExplanation(
    buyerTelegramId: string,
    recipientUsername?: string | null,
  ): Promise<string> {
    const rec = recipientUsername?.replace(/^@/, '').trim() || '';
    const buyerHit = await this.prisma.fraudList.findFirst({
      where: { telegram_id: buyerTelegramId },
    });
    const recipientHit =
      rec.length > 0
        ? await this.prisma.fraudList.findFirst({
            where: { username: rec },
          })
        : null;

    const parts: string[] = [];
    if (buyerHit) {
      parts.push('покупатель (Telegram ID в списке мошенников)');
    }
    if (recipientHit) {
      parts.push(`получатель @${rec} в списке мошенников`);
    }
    if (parts.length === 0) {
      return (
        'Платёж всё ещё помечается как мошеннический. Проверьте fraud_list: ' +
        'возможно, осталась вторая запись (ID и @username), либо несовпадение идентификатора при удалении.'
      );
    }
    return (
      `Блокировка доставки: ${parts.join(' и ')}. ` +
      `Удалите нужные записи в «Убрать из мошенников», затем снова нажмите «Протолкнуть транзакцию».`
    );
  }

  async getFraudList(): Promise<any[]> {
    try {
      return await this.prisma.fraudList.findMany({
        orderBy: {
          created_at: 'desc',
        },
      });
    } catch (error: any) {
      this.logger.error(`Error getting fraud list: ${error.message}`);
      return [];
    }
  }

  private async notifyFraudDetected(data: {
    telegram_id?: string;
    username?: string;
    reason?: string;
    added_by: string;
  }): Promise<void> {
    const channels = await this.settingsService.getFraudChannels();

    if (channels.length === 0) {
      return;
    }

    const identifier = data.telegram_id
      ? `<code>${data.telegram_id}</code>${data.username ? ` (@${data.username})` : ''}`
      : `@${data.username}`;

    const isSystem = data.added_by.startsWith('system:');
    let message: string;

    if (isSystem) {
      message = `🚨 <b>В список мошенников занесен аккаунт ${identifier}</b>`;
      if (data.reason) {
        message += `\n📋 ${data.reason}`;
      }
    } else {
      message = `🚨 <b>Поймали мошенника!</b>\n\n`;
      message += `👤 <b>Пользователь:</b> ${identifier}\n`;
      if (data.reason) {
        message += `📋 <b>Причина:</b> ${data.reason}\n`;
      }
      message += `👮 <b>Добавил:</b> ${data.added_by}`;
    }

    for (const channel of channels) {
      try {
        await this.adminBot.telegram.sendMessage(channel.channel_id, message, {
          parse_mode: 'HTML',
        });
      } catch (error: any) {
        this.logger.error(
          `Failed to send fraud notification to channel ${channel.channel_id}: ${error.message}`,
        );
      }
    }
  }

  async savePaymentPhone(
    paymentId: string,
    userTelegramId: string,
    phoneNumber: string,
  ): Promise<void> {
    try {
      await this.prisma.paymentPhone.upsert({
        where: { payment_id: paymentId },
        update: { phone_number: phoneNumber },
        create: {
          payment_id: paymentId,
          user_telegram_id: userTelegramId,
          phone_number: phoneNumber,
        },
      });
    } catch (error: any) {
      this.logger.error(
        `Error saving payment phone for ${paymentId}: ${error.message}`,
      );
    }
  }

  async checkPhoneFraud(
    userTelegramId: string,
    amountRub: number,
  ): Promise<{ isFraud: boolean; uniquePhones: string[] }> {
    try {
      const enabled = await this.settingsService.isPhoneFraudEnabled();
      if (!enabled) {
        return { isFraud: false, uniquePhones: [] };
      }

      const minAmount = await this.settingsService.getPhoneFraudMinAmount();
      if (amountRub < minAmount) {
        return { isFraud: false, uniquePhones: [] };
      }

      const phones = await this.prisma.paymentPhone.findMany({
        where: { user_telegram_id: userTelegramId },
        select: { phone_number: true },
      });

      const uniquePhones = [...new Set(phones.map((p) => p.phone_number))];

      return {
        isFraud: uniquePhones.length >= MAX_UNIQUE_PHONES_BEFORE_FRAUD,
        uniquePhones,
      };
    } catch (error: any) {
      this.logger.error(
        `Error checking phone fraud for ${userTelegramId}: ${error.message}`,
      );
      return { isFraud: false, uniquePhones: [] };
    }
  }

  async handlePhoneFraudDetected(
    userTelegramId: string,
    uniquePhones: string[],
  ): Promise<void> {
    if (await this.isInWhitelist(userTelegramId)) return;

    const alreadyInList = await this.isInFraudList(userTelegramId);
    if (alreadyInList) return;

    const reason = `Разные номера телефонов при оплате (${uniquePhones.join(', ')})`;

    await this.addToFraudList({
      telegram_id: userTelegramId,
      reason,
      added_by: 'system:phone_fraud',
    });

    this.logger.warn(
      `User ${userTelegramId} added to fraud list: ${uniquePhones.length} unique phone numbers`,
    );
  }

  async savePaymentCardMask(
    paymentId: string,
    userTelegramId: string,
    cardMask: string,
  ): Promise<void> {
    try {
      const stored = normalizePaymentCardMask(cardMask);
      await this.prisma.paymentCard.upsert({
        where: { payment_id: paymentId },
        update: { card_mask: stored },
        create: {
          payment_id: paymentId,
          user_telegram_id: userTelegramId,
          card_mask: stored,
        },
      });
    } catch (error: any) {
      this.logger.error(
        `Error saving payment card mask for ${paymentId}: ${error.message}`,
      );
    }
  }

  async checkCardFraud(
    userTelegramId: string,
    amountRub: number,
  ): Promise<{ isFraud: boolean; uniqueCards: string[] }> {
    try {
      const enabled = await this.settingsService.isCardFraudEnabled();
      if (!enabled) {
        return { isFraud: false, uniqueCards: [] };
      }

      const minAmount = await this.settingsService.getCardFraudMinAmount();
      if (amountRub < minAmount) {
        return { isFraud: false, uniqueCards: [] };
      }

      const cards = await this.prisma.paymentCard.findMany({
        where: { user_telegram_id: userTelegramId },
        select: { card_mask: true },
      });

      const masks = cards.map((c) => c.card_mask);
      const groups = mergeCardMaskGroups(masks);
      const uniqueCards = [...groups.values()].map((list) =>
        list.reduce((a, b) => (a.length >= b.length ? a : b)),
      );

      return {
        isFraud: uniqueCards.length >= MAX_UNIQUE_CARDS_BEFORE_FRAUD,
        uniqueCards,
      };
    } catch (error: any) {
      this.logger.error(
        `Error checking card fraud for ${userTelegramId}: ${error.message}`,
      );
      return { isFraud: false, uniqueCards: [] };
    }
  }

  async handleCardFraudDetected(
    userTelegramId: string,
    uniqueCards: string[],
  ): Promise<void> {
    if (await this.isInWhitelist(userTelegramId)) return;

    const alreadyInList = await this.isInFraudList(userTelegramId);
    if (alreadyInList) return;

    const reason = `Разные карты при оплате (${uniqueCards.join(', ')})`;

    await this.addToFraudList({
      telegram_id: userTelegramId,
      reason,
      added_by: 'system:card_fraud',
    });

    this.logger.warn(
      `User ${userTelegramId} added to fraud list: ${uniqueCards.length} unique card masks`,
    );
  }

  async checkConsecutiveCancellations(
    userTelegramId: string,
  ): Promise<boolean> {
    try {
      const enabled = await this.settingsService.isCancellationFraudEnabled();
      if (!enabled) return false;

      const minAmountRub =
        await this.settingsService.getCancellationFraudMinAmount();

      const lastOrders = await this.prisma.payment.findMany({
        where: {
          user_telegram_id: userTelegramId,
          product_type: {
            in: [ProductType.STARS, ProductType.PREMIUM, ProductType.TON],
          },
        },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { status: true, product_quantity: true, amount_rub: true },
      });

      const bigOrders = lastOrders.filter(
        (o) => parseFloat(o.amount_rub?.toString() || '0') >= minAmountRub,
      );

      if (bigOrders.length < MAX_CONSECUTIVE_CANCELLED_ORDERS) {
        return false;
      }

      let consecutiveCancelled = 0;
      for (const order of bigOrders) {
        if (order.status === 'CANCELLED') {
          consecutiveCancelled++;
          if (consecutiveCancelled >= MAX_CONSECUTIVE_CANCELLED_ORDERS) {
            break;
          }
        } else {
          consecutiveCancelled = 0;
        }
      }
      if (consecutiveCancelled < MAX_CONSECUTIVE_CANCELLED_ORDERS) return false;

      if (await this.isInWhitelist(userTelegramId)) return false;

      const alreadyInList = await this.isInFraudList(userTelegramId);
      if (alreadyInList) return false;

      await this.addToFraudList({
        telegram_id: userTelegramId,
        reason: `${MAX_CONSECUTIVE_CANCELLED_ORDERS} отменённых заказов от ${minAmountRub}₽ подряд`,
        added_by: 'system:cancelled_orders',
      });

      this.logger.warn(
        `User ${userTelegramId} added to fraud list: ${MAX_CONSECUTIVE_CANCELLED_ORDERS} consecutive cancelled orders (${minAmountRub}+ rub)`,
      );

      return true;
    } catch (error: any) {
      this.logger.error(
        `Error checking consecutive cancellations for ${userTelegramId}: ${error.message}`,
      );
      return false;
    }
  }

  async findByIdentifier(
    identifier: string,
  ): Promise<{ telegram_id?: string; username?: string } | null> {
    try {
      if (/^\d+$/.test(identifier)) {
        return { telegram_id: identifier };
      }

      if (identifier.startsWith('@')) {
        return { username: identifier.replace('@', '') };
      }

      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { telegram_id: identifier },
            { username: identifier.replace('@', '') },
          ],
        },
      });

      if (user) {
        return {
          telegram_id: user.telegram_id,
          username: user.username || undefined,
        };
      }

      return { username: identifier };
    } catch (error: any) {
      this.logger.error(`Error finding user by identifier: ${error.message}`);
      return null;
    }
  }
}
