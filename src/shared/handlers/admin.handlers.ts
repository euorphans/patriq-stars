import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PaymentStatus } from '@prisma/client';
import { SettingsService } from '@/modules/settings/settings.service';
import { PaymentsService } from '@/modules/payments/payments.service';
import { UserService } from '@/modules/user/user.service';
import { TelegramBotService } from '@/shared/services/telegram/telegram-bot.service';
import { AdminKeyboard } from '@/shared/keyboards/admin.keyboard';
import { formatDateMoscow } from '@/shared/utils';
import {
  I18nService,
  SupportedLanguage,
} from '@/shared/services/i18n/i18n.service';

@Injectable()
export class AdminHandlers {
  private readonly logger = new Logger(AdminHandlers.name);

  constructor(
    private readonly settingsService: SettingsService,
    private readonly paymentsService: PaymentsService,
    private readonly userService: UserService,
    private readonly botService: TelegramBotService,
    private readonly i18n: I18nService,
    private readonly showCloseButton: boolean = false,
    private readonly showPaymentSystemsInSettings: boolean = false,
  ) {}

  async showAdminMenu(ctx: Context): Promise<void> {
    const text = `
👨‍💼 <b>Админ панель</b>

Полный доступ к управлению ботом. Выберите нужный раздел в меню ниже.
`;

    try {
      if ((ctx as any).callbackQuery) {
        await ctx.deleteMessage();
      }
    } catch {}

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getMainMenu(this.showCloseButton)
        .reply_markup,
    });
  }

  async showStatsForPeriod(
    ctx: Context,
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    try {
      const stats = await this.getGeneralStats(startDate, endDate);
      const lang = await this.resolveStatsLang(ctx);
      const period = `${formatDateMoscow(startDate)} - ${formatDateMoscow(endDate)}`;
      const text = this.formatStatsMessage(stats, lang, period);

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getStatsMenu().reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error showing stats for period: ${error.message}`);
      const lang = await this.resolveStatsLang(ctx);
      await ctx.reply(this.i18n.t('admin.stats.error_period', lang));
    }
  }

  async showStats(ctx: Context): Promise<void> {
    try {
      try {
        await ctx.deleteMessage();
      } catch {}

      const stats = await this.getGeneralStats();
      const lang = await this.resolveStatsLang(ctx);
      const text = this.formatStatsMessage(
        stats,
        lang,
        this.i18n.t('admin.stats.all_time', lang),
      );

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getStatsMenu().reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error showing stats: ${error.message}`);
      const lang = await this.resolveStatsLang(ctx);
      await ctx.reply(this.i18n.t('admin.stats.error', lang));
    }
  }

  async showSettingsMenu(ctx: Context): Promise<void> {
    try {
      try {
        await ctx.deleteMessage();
      } catch {}

      const [botEnabled, paymentCaptcha] = await Promise.all([
        this.settingsService.isBotEnabled(),
        this.settingsService.isPaymentCaptchaEnabled(),
      ]);

      await ctx.reply(
        `⚙️ <b>Статус бота:</b> ${botEnabled ? '🟢 Включен' : '🔴 Выключен'}\n` +
          `🎯 <b>Капча перед оплатой (эмодзи):</b> ${paymentCaptcha ? '🟢 Вкл' : '🔴 Выкл'}`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getSettingsMenu(
            botEnabled,
            this.showPaymentSystemsInSettings,
            paymentCaptcha,
          ).reply_markup,
        },
      );
    } catch (error: any) {
      this.logger.error(`Error showing settings menu: ${error.message}`);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  async toggleBot(ctx: Context): Promise<void> {
    try {
      const [currentBotState, paymentCaptcha] = await Promise.all([
        this.settingsService.isBotEnabled(),
        this.settingsService.isPaymentCaptchaEnabled(),
      ]);
      await this.settingsService.setBotEnabled(!currentBotState);

      const newState = !currentBotState;
      const text = newState
        ? '✅ Бот включен'
        : '⚠️ Бот выключен. Пользователи не смогут использовать бота.';

      await ctx.answerCbQuery(text);
      await ctx.editMessageText(
        `⚙️ <b>Статус бота:</b> ${newState ? '🟢 Включен' : '🔴 Выключен'}\n` +
          `🎯 <b>Капча перед оплатой (эмодзи):</b> ${paymentCaptcha ? '🟢 Вкл' : '🔴 Выкл'}`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getSettingsMenu(
            newState,
            this.showPaymentSystemsInSettings,
            paymentCaptcha,
          ).reply_markup,
        },
      );
    } catch (error: any) {
      this.logger.error(`Error toggling bot: ${error.message}`);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  async togglePaymentCaptcha(ctx: Context): Promise<void> {
    try {
      const [botEnabled, currentPayment] = await Promise.all([
        this.settingsService.isBotEnabled(),
        this.settingsService.isPaymentCaptchaEnabled(),
      ]);
      await this.settingsService.setPaymentCaptchaEnabled(!currentPayment);

      const newPayment = !currentPayment;
      const text = newPayment
        ? '✅ Капча перед оплатой включена'
        : '⚠️ Капча перед оплатой выключена';

      await ctx.answerCbQuery(text);
      await ctx.editMessageText(
        `⚙️ <b>Статус бота:</b> ${botEnabled ? '🟢 Включен' : '🔴 Выключен'}\n` +
          `🎯 <b>Капча перед оплатой (эмодзи):</b> ${newPayment ? '🟢 Вкл' : '🔴 Выкл'}`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getSettingsMenu(
            botEnabled,
            this.showPaymentSystemsInSettings,
            newPayment,
          ).reply_markup,
        },
      );
    } catch (error: any) {
      this.logger.error(`Error toggling payment captcha: ${error.message}`);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  async showBroadcastMenu(ctx: Context): Promise<void> {
    const text = `
📢 <b>Рассылка сообщений</b>

Отправьте сообщение для рассылки (текст, фото, GIF, видео, стикер или музыку с подписью).

Можно использовать HTML форматирование.

После подтверждения отправки вы выберете аудиторию: <b>все пользователи</b>, <b>только с Premium</b> или <b>без Premium</b>.
`;

    try {
      await ctx.deleteMessage();
    } catch {}

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
    });

    (ctx as any).session.awaitingBroadcast = true;
    (ctx as any).session.lastBotMessageId = message.message_id;
  }

  async startBroadcast(ctx: Context, session: any): Promise<void> {
    let text = `📝 <b>Отправьте сообщение для рассылки</b>

Сообщение будет отправлено всем активным пользователям бота.

<i>Отправьте текст или фото с подписью</i>`;

    if (session.lastBroadcastStats) {
      const stats = session.lastBroadcastStats;
      text += `

━━━━━━━━━━━━━━━━━━━
📊 <b>Последняя рассылка:</b>
📅 ${stats.date}
👥 Всего пользователей: ${stats.total}
✅ Отправлено: ${stats.success}
❌ Ошибок: ${stats.failed}`;
    }

    const sentMessage = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
    });

    session.awaitingBroadcast = true;
    session.lastBotMessageId = sentMessage.message_id;
  }

  async sendBroadcast(
    ctx: Context,
    message: string,
    options?: {
      photo?: string;
      animation?: string;
      video?: string;
      sticker?: string;
      audio?: string;
      testMode?: boolean;
      entities?: any[];
      caption_entities?: any[];
      buttons?: Array<{ text: string; url: string }>;
      onProgress?: (stats: {
        total: number;
        processed: number;
        success: number;
        failed: number;
      }) => Promise<void>;
      progressInterval?: number;
    },
  ): Promise<{ total: number; success: number; failed: number }> {
    try {
      let testRecipients: { telegram_id: string }[] | undefined;
      if (options?.testMode) {
        testRecipients = await this.userService.getAllAdmins();
        this.logger.log(
          `[BROADCAST TEST] Sending to ${testRecipients.length} admins`,
        );
      }

      const result = await this.botService.broadcastToAllUsers(message, {
        photo: options?.photo,
        animation: options?.animation,
        video: options?.video,
        sticker: options?.sticker,
        audio: options?.audio,
        testMode: options?.testMode || false,
        testRecipients,
        entities: options?.entities,
        caption_entities: options?.caption_entities,
        buttons: options?.buttons || [],
        onProgress: options?.onProgress,
        progressInterval: options?.progressInterval,
      });

      this.logger.log(
        `[BROADCAST RESULT] Total: ${result.total}, Success: ${result.success}, Failed: ${result.failed}`,
      );
      return result;
    } catch (error: any) {
      this.logger.error(`Error sending broadcast: ${error.message}`);
      await ctx.reply('❌ Ошибка отправки рассылки');
      return { total: 0, success: 0, failed: 0 };
    }
  }

  private async resolveStatsLang(_ctx: Context): Promise<SupportedLanguage> {
    return 'ru';
  }

  private statsLocale(_lang: SupportedLanguage): string {
    return 'ru-RU';
  }

  private formatStatsMessage(
    stats: any,
    lang: SupportedLanguage,
    periodLabel: string,
  ): string {
    const loc = this.statsLocale(lang);
    const t = (key: string, params?: Record<string, string | number>) =>
      this.i18n.t(`admin.stats.${key}`, lang, params);

    const fmtRubAmt = (num: number) =>
      num.toLocaleString(loc, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const rubProfitLine = (profit: number) =>
      t('line_net_profit', { amount: fmtRubAmt(profit) });

    const rubMethodBlock = (
      sectionKey: string,
      row: {
        turnover: number;
        fees: number;
        profit: number;
        products: any;
      },
    ) => {
      return `${t(sectionKey)}
${t('line_turnover_rub', { amount: fmtRubAmt(row.turnover) })}
${t('line_system_fee_rub', { amount: fmtRubAmt(row.fees) })}
${rubProfitLine(row.profit)}
${t('goods_block')}
${this.formatProductsBlock(row.products, lang, loc)}`;
    };

    return `${t('title')}

${t('period', { period: periodLabel })}

${t('section_users')}
${t('users_day', { n: stats.users.day })}
${t('users_week', { n: stats.users.week })}
${t('users_total', { n: stats.users.total })}
${t('users_premium', { n: stats.users.premium, pct: stats.users.premiumPercent })}

${t('section_orders')}
${t('orders_total', { n: stats.orders.total })}
${t('orders_completed', { n: stats.orders.completed })}
${t('orders_pending', { n: stats.orders.pending })}
${t('orders_cancelled', { n: stats.orders.cancelled })}

${rubMethodBlock('section_freekassa', stats.freekassa)}

${t('section_heleket')}
${t('line_turnover_usd', { amount: stats.heleket.turnover.toFixed(2) })}
${t('line_system_fee_usd', { amount: stats.heleket.fees.toFixed(2) })}
${rubProfitLine(stats.heleket.profit)}
${t('goods_block')}
${this.formatProductsBlock(stats.heleket.products, lang, loc)}

${t('section_ton')}
${t('line_turnover_ton', { amount: stats.ton.turnover.toFixed(2) })}
${rubProfitLine(stats.ton.profit)}
${t('goods_block')}
${this.formatProductsBlock(stats.ton.products, lang, loc)}

${t('section_totals')}
${t('totals_net_profit', { amount: fmtRubAmt(stats.totals.profit) })}
${t('totals_goods')}
${t('totals_stars', { n: stats.totals.products.stars.toLocaleString(loc) })}
${t('totals_ton', { n: stats.totals.products.ton })}
${t('totals_gifts', { n: stats.totals.products.gifts })}
${t('totals_premium_title')}
${t('premium_3', { n: stats.totals.products.premium['3'] })}
${t('premium_6', { n: stats.totals.products.premium['6'] })}
${t('premium_12', { n: stats.totals.products.premium['12'] })}
`;
  }

  private formatProductsBlock(
    products: {
      stars: number;
      ton: number;
      gifts: number;
      premium: { '3': number; '6': number; '12': number };
    },
    lang: SupportedLanguage,
    loc: string,
  ): string {
    const t = (key: string, params?: Record<string, string | number>) =>
      this.i18n.t(`admin.stats.${key}`, lang, params);

    return `${t('stars_sold', { n: products.stars.toLocaleString(loc) })}
${t('ton_sold', { n: products.ton })}
${t('gifts_sold', { n: products.gifts })}
${t('premium_title')}
${t('premium_3', { n: products.premium['3'] })}
${t('premium_6', { n: products.premium['6'] })}
${t('premium_12', { n: products.premium['12'] })}`;
  }

  private async getGeneralStats(
    startDate?: Date,
    endDate?: Date,
  ): Promise<any> {
    const prisma = this.paymentsService['prisma'];

    const dateFilter =
      startDate && endDate
        ? {
            created_at: {
              gte: startDate,
              lte: endDate,
            },
          }
        : undefined;

    const usersCount = dateFilter
      ? await prisma.user.count({ where: dateFilter })
      : await this.userService.getUsersCount();

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    if (startDate && weekAgo < startDate) {
      weekAgo.setTime(startDate.getTime());
    }
    const dayAgo = new Date();
    dayAgo.setDate(dayAgo.getDate() - 1);
    if (startDate && dayAgo < startDate) {
      dayAgo.setTime(startDate.getTime());
    }

    let weekUsers = 0;
    let dayUsers = 0;

    if (startDate && endDate) {
      const periodEnd = new Date(endDate);
      const periodStart = new Date(startDate);
      const dayDuration = 24 * 60 * 60 * 1000;
      const weekDuration = 7 * dayDuration;

      const dayStart = new Date(periodEnd.getTime() - dayDuration);
      if (dayStart < periodStart) {
        dayStart.setTime(periodStart.getTime());
      }
      dayUsers = await prisma.user.count({
        where: {
          created_at: {
            gte: dayStart,
            lte: periodEnd,
          },
        },
      });

      const weekStart = new Date(periodEnd.getTime() - weekDuration);
      if (weekStart < periodStart) {
        weekStart.setTime(periodStart.getTime());
      }
      weekUsers = await prisma.user.count({
        where: {
          created_at: {
            gte: weekStart,
            lte: periodEnd,
          },
        },
      });
    } else {
      weekUsers = await this.userService.getUsersCount(weekAgo);
      dayUsers = await this.userService.getUsersCount(dayAgo);
    }

    const premiumUsers = await prisma.user.count({
      where: { is_premium: true },
    });
    const premiumPercent =
      usersCount > 0 ? ((premiumUsers / usersCount) * 100).toFixed(1) : '0.0';

    const ordersStatsFilter = dateFilter
      ? {
          created_at: {
            gte: startDate,
            lte: endDate,
          },
        }
      : {};

    const ordersStats = await this.getPaymentStatsForPeriod(ordersStatsFilter);
    const pendingOrders = await prisma.payment.count({
      where: {
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        ...ordersStatsFilter,
      },
    });

    const queryStartDate = startDate || new Date('2000-01-01');
    const queryEndDate = endDate || new Date('2100-01-01');

    const methodStats: any[] = await prisma.$queryRaw`
      SELECT
        payment_method,
        -- Turnover per method
        COALESCE(SUM(CASE WHEN payment_method = 'FREEKASSA' THEN amount_rub ELSE 0 END), 0)::float AS turnover_rub,
        COALESCE(SUM(CASE WHEN payment_method = 'HELEKET' THEN amount_usd ELSE 0 END), 0)::float AS turnover_usd,
        COALESCE(SUM(CASE WHEN payment_method = 'TON' THEN COALESCE(amount_ton, 0) ELSE 0 END), 0)::float AS turnover_ton,
        -- Fees
        COALESCE(SUM(
          CASE
            WHEN payment_method = 'FREEKASSA' THEN amount_rub * COALESCE(NULLIF(payment_system_fee_percent, 0), 6) / 100
            WHEN payment_method = 'HELEKET' THEN amount_usd * COALESCE(NULLIF(payment_system_fee_percent, 0), 2) / 100
            ELSE 0
          END
        ), 0)::float AS fees,
        -- Profit
        COALESCE(SUM(
          CASE
            WHEN COALESCE(net_profit_rub, 0) > 0 THEN net_profit_rub
            ELSE COALESCE(purchase_price_usd, 0)
                 * COALESCE(NULLIF(service_markup_percent, 0), 13) / 100
                 * COALESCE(NULLIF(usd_rate, 0), 1)
          END
        ), 0)::float AS profit,
        -- Products
        COALESCE(SUM(CASE WHEN product_type = 'STARS' THEN CAST(product_quantity AS NUMERIC) ELSE 0 END), 0)::int AS stars_qty,
        COALESCE(SUM(CASE WHEN product_type = 'TON' THEN CAST(product_quantity AS NUMERIC) ELSE 0 END), 0)::float AS ton_qty,
        0::int AS gifts_qty,
        COUNT(CASE WHEN product_type = 'PREMIUM' AND product_quantity = '3' THEN 1 END)::int AS premium_3,
        COUNT(CASE WHEN product_type = 'PREMIUM' AND product_quantity = '6' THEN 1 END)::int AS premium_6,
        COUNT(CASE WHEN product_type = 'PREMIUM' AND product_quantity = '12' THEN 1 END)::int AS premium_12
      FROM payments
      WHERE status = 'COMPLETED'
        AND created_at >= ${queryStartDate}
        AND created_at <= ${queryEndDate}
      GROUP BY payment_method
    `;

    const emptyMethodStats = {
      turnover: 0,
      fees: 0,
      profit: 0,
      products: {
        stars: 0,
        ton: 0,
        gifts: 0,
        premium: { '3': 0, '6': 0, '12': 0 },
      },
    };

    const getStatsByMethod = (method: string) => {
      const row = methodStats.find((r) => r.payment_method === method);
      if (!row)
        return {
          ...emptyMethodStats,
          products: {
            ...emptyMethodStats.products,
            premium: { ...emptyMethodStats.products.premium },
          },
        };

      let turnover = 0;
      if (method === 'FREEKASSA') turnover = row.turnover_rub;
      else if (method === 'HELEKET') turnover = row.turnover_usd;
      else if (method === 'TON') turnover = row.turnover_ton;

      return {
        turnover,
        fees: method === 'TON' ? 0 : row.fees,
        profit: row.profit,
        products: {
          stars: row.stars_qty,
          ton: row.ton_qty,
          gifts: row.gifts_qty ?? 0,
          premium: {
            '3': row.premium_3,
            '6': row.premium_6,
            '12': row.premium_12,
          },
        },
      };
    };

    const freekassaStats = getStatsByMethod('FREEKASSA');
    const heleketStats = getStatsByMethod('HELEKET');
    const tonStats = getStatsByMethod('TON');
    const totalProfitRub =
      freekassaStats.profit + heleketStats.profit + tonStats.profit;

    return {
      users: {
        total: usersCount,
        week: weekUsers,
        day: dayUsers,
        premium: premiumUsers,
        premiumPercent,
      },
      orders: {
        total: ordersStats.total,
        completed: ordersStats.completed,
        pending: pendingOrders,
        cancelled: ordersStats.cancelled,
      },
      freekassa: {
        turnover: freekassaStats.turnover,
        fees: freekassaStats.fees,
        profit: freekassaStats.profit,
        products: freekassaStats.products,
      },
      heleket: {
        turnover: heleketStats.turnover,
        fees: heleketStats.fees,
        profit: heleketStats.profit,
        products: heleketStats.products,
      },
      ton: {
        turnover: tonStats.turnover,
        profit: tonStats.profit,
        products: tonStats.products,
      },
      totals: {
        profit: totalProfitRub,
        products: {
          stars:
            freekassaStats.products.stars +
            heleketStats.products.stars +
            tonStats.products.stars,
          ton:
            freekassaStats.products.ton +
            heleketStats.products.ton +
            tonStats.products.ton,
          gifts:
            freekassaStats.products.gifts +
            heleketStats.products.gifts +
            tonStats.products.gifts,
          premium: {
            '3':
              freekassaStats.products.premium['3'] +
              heleketStats.products.premium['3'] +
              tonStats.products.premium['3'],
            '6':
              freekassaStats.products.premium['6'] +
              heleketStats.products.premium['6'] +
              tonStats.products.premium['6'],
            '12':
              freekassaStats.products.premium['12'] +
              heleketStats.products.premium['12'] +
              tonStats.products.premium['12'],
          },
        },
      },
    };
  }

  private async getPaymentStatsForPeriod(filter: any): Promise<{
    total: number;
    completed: number;
    processing: number;
    cancelled: number;
  }> {
    const prisma = this.paymentsService['prisma'];
    const [total, completed, processing, cancelled] = await Promise.all([
      prisma.payment.count({ where: filter }),
      prisma.payment.count({
        where: { ...filter, status: PaymentStatus.COMPLETED },
      }),
      prisma.payment.count({
        where: { ...filter, status: PaymentStatus.PROCESSING },
      }),
      prisma.payment.count({
        where: { ...filter, status: PaymentStatus.CANCELLED },
      }),
    ]);

    return {
      total,
      completed,
      processing,
      cancelled,
    };
  }
}
