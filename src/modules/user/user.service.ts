import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '@/modules/settings/settings.service';
import { PrismaService } from '@/shared/services/prisma/prisma.service';

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_premium?: boolean;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  private userCache = new Map<string, { user: any; expires: number }>();
  private readonly USER_CACHE_TTL = 300000;

  private bannedUsernameCache = new Map<
    string,
    { banned: boolean; expires: number }
  >();
  private readonly BANNED_CACHE_TTL = 60000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  async findByTelegramId(telegramId: string) {
    const cached = this.userCache.get(telegramId);
    if (cached && Date.now() < cached.expires) {
      return cached.user;
    }

    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });

    this.userCache.set(telegramId, {
      user,
      expires: Date.now() + this.USER_CACHE_TTL,
    });
    return user;
  }

  async findByTelegramIdOrUsername(query: string) {
    const byId = await this.prisma.user.findUnique({
      where: { telegram_id: query },
    });
    if (byId) return byId;

    const username = query.replace(/^@/, '');
    return this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
  }

  clearUserCache(telegramId?: string): void {
    if (telegramId) {
      this.userCache.delete(telegramId);
    } else {
      this.userCache.clear();
    }
  }

  async createOrUpdateFromTelegram(
    telegramUser: TelegramUser,
  ): Promise<{ user: any; isNew: boolean }> {
    const telegramId = telegramUser.id.toString();

    let isBanned = false;
    if (telegramUser.username) {
      isBanned = await this.isUsernameBanned(telegramUser.username);
    }

    this.clearUserCache(telegramId);

    const existingUser = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });

    const isNew = !existingUser;

    const user = await this.prisma.user.upsert({
      where: { telegram_id: telegramId },
      update: {
        username: telegramUser.username,
        first_name: telegramUser.first_name,
        last_name: telegramUser.last_name,
        is_premium: telegramUser.is_premium ?? false,
        is_bot_blocked: false,

        ...(isBanned ? { is_ban: true } : {}),
      },
      create: {
        telegram_id: telegramId,
        username: telegramUser.username,
        first_name: telegramUser.first_name,
        last_name: telegramUser.last_name,
        is_premium: telegramUser.is_premium ?? false,
        is_ban: isBanned,
        language: '',
      },
    });

    this.userCache.set(telegramId, {
      user,
      expires: Date.now() + this.USER_CACHE_TTL,
    });

    return { user, isNew };
  }

  async syncPremiumStatus(
    telegramId: string,
    isPremium: boolean,
  ): Promise<void> {
    await this.prisma.user.upsert({
      where: { telegram_id: telegramId },
      update: { is_premium: isPremium },
      create: {
        telegram_id: telegramId,
        is_premium: isPremium,
        language: '',
      },
    });
  }

  async acceptAgreement(telegramId: string) {
    this.clearUserCache(telegramId);
    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!user) {
      this.logger.warn(`acceptAgreement: user ${telegramId} not found`);
      return null;
    }
    return this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: { agreement: true },
    });
  }

  async getUsersCount(since?: Date): Promise<number> {
    return this.prisma.user.count({
      where: since ? { created_at: { gte: since } } : undefined,
    });
  }

  async blockUser(telegramId: string) {
    this.clearUserCache(telegramId);
    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!user) {
      this.logger.warn(`blockUser: user ${telegramId} not found`);
      return null;
    }
    return this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: { is_ban: true },
    });
  }

  async unblockUser(telegramId: string) {
    this.clearUserCache(telegramId);
    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!user) {
      this.logger.warn(`unblockUser: user ${telegramId} not found`);
      return null;
    }
    return this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: { is_ban: false },
    });
  }

  async isAdmin(telegramId: string): Promise<boolean> {
    const user = await this.findByTelegramId(telegramId);
    return user?.role === 'ADMIN';
  }

  async getAllAdmins(): Promise<{ telegram_id: string }[]> {
    return this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { telegram_id: true },
    });
  }

  async findUserByIdOrUsername(identifier: string): Promise<any | null> {
    const cleanId = identifier.replace('@', '').trim();

    let user = await this.findByTelegramId(cleanId);

    if (!user) {
      user = await this.prisma.user.findFirst({
        where: { username: cleanId },
      });
    }

    return user;
  }

  async getUserLanguage(telegramId: string): Promise<'ru'> {
    return 'ru';
  }

  async setUserLanguage(
    telegramId: string,
    language: 'ru',
  ): Promise<void> {
    this.clearUserCache(telegramId);
    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!user) {
      this.logger.warn(`setUserLanguage: user ${telegramId} not found`);
      return;
    }
    await this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: { language },
    });
  }

  async addBannedUsername(username: string, reason?: string): Promise<void> {
    const cleanUsername = username.replace('@', '').trim();
    await this.prisma.bannedUsername.upsert({
      where: { username: cleanUsername },
      create: { username: cleanUsername, reason },
      update: { reason },
    });
  }

  async removeBannedUsername(username: string): Promise<void> {
    const cleanUsername = username.replace('@', '').trim();
    await this.prisma.bannedUsername.deleteMany({
      where: { username: cleanUsername },
    });
  }

  async isUsernameBanned(username: string): Promise<boolean> {
    const cleanUsername = username.replace('@', '').trim().toLowerCase();

    const cached = this.bannedUsernameCache.get(cleanUsername);
    if (cached && Date.now() < cached.expires) {
      return cached.banned;
    }

    const banned = await this.prisma.bannedUsername.findUnique({
      where: { username: cleanUsername },
    });
    const isBanned = !!banned;

    this.bannedUsernameCache.set(cleanUsername, {
      banned: isBanned,
      expires: Date.now() + this.BANNED_CACHE_TTL,
    });

    return isBanned;
  }

  async isUserBannedByUsername(username: string): Promise<boolean> {
    const cleanUsername = username.replace('@', '').trim();

    const preemptiveBan = await this.isUsernameBanned(cleanUsername);
    if (preemptiveBan) return true;

    const user = await this.prisma.user.findFirst({
      where: { username: cleanUsername },
    });

    return user?.is_ban ?? false;
  }

  async getCaptchaStatus(telegramId: string): Promise<{
    needsCaptcha: boolean;
    isCaptchaBanned: boolean;
    passedCount: number;
    failedCount: number;
  }> {
    const captchaEnabled = await this.settingsService.isPaymentCaptchaEnabled();
    const user = await this.findByTelegramId(telegramId);

    if (!captchaEnabled) {
      return {
        needsCaptcha: false,
        isCaptchaBanned: user?.is_captcha_banned ?? false,
        passedCount: user?.captcha_passed_count ?? 0,
        failedCount: user?.captcha_failed_count ?? 0,
      };
    }

    if (!user) {
      return {
        needsCaptcha: true,
        isCaptchaBanned: false,
        passedCount: 0,
        failedCount: 0,
      };
    }

    return {
      needsCaptcha: user.captcha_passed_count < 3 && !user.is_captcha_banned,
      isCaptchaBanned: user.is_captcha_banned,
      passedCount: user.captcha_passed_count,
      failedCount: user.captcha_failed_count,
    };
  }

  async incrementCaptchaPassed(telegramId: string): Promise<void> {
    this.clearUserCache(telegramId);
    const existing = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!existing) {
      this.logger.warn(`incrementCaptchaPassed: user ${telegramId} not found`);
      return;
    }
    await this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: { captcha_passed_count: { increment: 1 } },
    });
  }

  async incrementCaptchaFailed(
    telegramId: string,
  ): Promise<{ banned: boolean; failedCount: number }> {
    this.clearUserCache(telegramId);
    const existing = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!existing) {
      this.logger.warn(`incrementCaptchaFailed: user ${telegramId} not found`);
      return { banned: false, failedCount: 0 };
    }
    const user = await this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: { captcha_failed_count: { increment: 1 } },
    });

    if (user.captcha_failed_count >= 3) {
      await this.prisma.user.update({
        where: { telegram_id: telegramId },
        data: { is_captcha_banned: true },
      });
      this.clearUserCache(telegramId);
      return { banned: true, failedCount: user.captcha_failed_count };
    }

    return { banned: false, failedCount: user.captcha_failed_count };
  }

  async liftCaptchaBan(telegramId: string): Promise<void> {
    this.clearUserCache(telegramId);
    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
    });
    if (!user) {
      this.logger.warn(`liftCaptchaBan: user ${telegramId} not found`);
      return;
    }
    await this.prisma.user.update({
      where: { telegram_id: telegramId },
      data: {
        is_captcha_banned: false,
        captcha_failed_count: 0,
      },
    });
  }

  async liftCaptchaBanByUsername(username: string): Promise<boolean> {
    const cleanUsername = username.replace('@', '').trim();
    const user = await this.prisma.user.findFirst({
      where: { username: cleanUsername },
    });
    if (!user) return false;

    this.clearUserCache(user.telegram_id);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        is_captcha_banned: false,
        captcha_failed_count: 0,
      },
    });
    return true;
  }

  async setReferrer(
    newUserTelegramId: string,
    referrerTelegramId: string,
  ): Promise<boolean> {
    try {
      if (newUserTelegramId === referrerTelegramId) return false;

      const [newUser, referrer] = await Promise.all([
        this.prisma.user.findUnique({
          where: { telegram_id: newUserTelegramId },
          select: { id: true, referred_by: true },
        }),
        this.prisma.user.findUnique({
          where: { telegram_id: referrerTelegramId },
          select: { id: true },
        }),
      ]);

      if (!newUser || !referrer) return false;
      if (newUser.referred_by) return false;

      await this.prisma.user.update({
        where: { telegram_id: newUserTelegramId },
        data: { referred_by: referrer.id },
      });

      this.clearUserCache(newUserTelegramId);
      this.logger.log(
        `Set referrer ${referrerTelegramId} for user ${newUserTelegramId}`,
      );
      return true;
    } catch (error: any) {
      this.logger.error(
        `Error setting referrer: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  async getReferralStats(telegramId: string): Promise<{ count: number }> {
    const user = await this.prisma.user.findUnique({
      where: { telegram_id: telegramId },
      select: { id: true },
    });
    if (!user) return { count: 0 };

    const count = await this.prisma.user.count({
      where: { referred_by: user.id },
    });

    return { count };
  }
}
