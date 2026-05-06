import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { FragmentAccountCredentials } from './fragment.service';

@Injectable()
export class FragmentAccountService implements OnModuleInit {
  private readonly logger = new Logger(FragmentAccountService.name);

  private roundRobinIndex = 0;

  private cachedAccounts: FragmentAccountCredentials[] = [];
  private lastCacheRefresh = 0;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refreshCache();

    if (this.cachedAccounts.length === 0) {
      await this.migrateLegacyEnvAccount();
    }

    this.logger.log(
      `FragmentAccountService initialized with ${this.cachedAccounts.length} active account(s)`,
    );
  }

  private async migrateLegacyEnvAccount(): Promise<void> {
    const ssid = process.env.FRAGMENT_STEL_SSID;
    const token = process.env.FRAGMENT_STEL_TOKEN;
    const tonToken = process.env.FRAGMENT_STEL_TON_TOKEN;

    if (!ssid || !token || !tonToken) {
      this.logger.warn(
        'No Fragment accounts in DB and no legacy env variables found. Add accounts via admin bot.',
      );
      return;
    }

    this.logger.log(
      'Migrating legacy env-based Fragment account to database...',
    );

    try {
      const existing = await this.prisma.fragmentAccount.findFirst({
        where: {
          stel_ssid: ssid,
          stel_token: token,
        },
      });

      if (existing) {
        this.logger.log(
          'Legacy account already exists in database, skipping migration',
        );
        await this.refreshCache();
        return;
      }

      await this.prisma.fragmentAccount.create({
        data: {
          name: 'Legacy (env)',
          stel_ssid: ssid,
          stel_token: token,
          stel_ton_token: tonToken,
          is_active: true,
        },
      });

      this.logger.log(
        'Legacy env-based Fragment account migrated to database successfully',
      );
      await this.refreshCache();
    } catch (error: any) {
      this.logger.error(`Failed to migrate legacy account: ${error.message}`);
    }
  }

  async refreshCache(): Promise<void> {
    try {
      const accounts = await this.prisma.fragmentAccount.findMany({
        where: { is_active: true },
        orderBy: { created_at: 'asc' },
      });

      this.cachedAccounts = accounts.map((a) => ({
        id: a.id,
        name: a.name,
        stel_ssid: a.stel_ssid,
        stel_token: a.stel_token,
        stel_ton_token: a.stel_ton_token,
        stel_hash: a.stel_hash ?? undefined,
      }));

      this.lastCacheRefresh = Date.now();
    } catch (error: any) {
      this.logger.error(`Failed to refresh account cache: ${error.message}`);
    }
  }

  private async ensureFreshCache(): Promise<void> {
    if (Date.now() - this.lastCacheRefresh > this.CACHE_TTL_MS) {
      await this.refreshCache();
    }
  }

  async getNextAccount(): Promise<FragmentAccountCredentials | null> {
    await this.ensureFreshCache();

    if (this.cachedAccounts.length === 0) {
      this.logger.error('No active Fragment accounts available!');
      return null;
    }

    if (this.roundRobinIndex >= this.cachedAccounts.length) {
      this.roundRobinIndex = 0;
    }

    const account = this.cachedAccounts[this.roundRobinIndex];
    this.roundRobinIndex =
      (this.roundRobinIndex + 1) % this.cachedAccounts.length;

    this.logger.debug(
      `Selected Fragment account: ${account.name} (${account.id})`,
    );

    return account;
  }

  async getNextAccountExcluding(
    excludeIds: string[],
  ): Promise<FragmentAccountCredentials | null> {
    await this.ensureFreshCache();

    const available = this.cachedAccounts.filter(
      (a) => !excludeIds.includes(a.id),
    );

    if (available.length === 0) {
      return null;
    }

    const index = this.roundRobinIndex % available.length;
    const account = available[index];

    this.logger.debug(
      `Selected Fragment account (excluding ${excludeIds.length}): ${account.name} (${account.id})`,
    );

    return account;
  }

  async getAllActiveAccounts(): Promise<FragmentAccountCredentials[]> {
    await this.ensureFreshCache();
    return [...this.cachedAccounts];
  }

  async getAccountById(id: string): Promise<FragmentAccountCredentials | null> {
    await this.ensureFreshCache();

    const account = this.cachedAccounts.find((a) => a.id === id);
    if (account) {
      return account;
    }

    const dbAccount = await this.prisma.fragmentAccount.findUnique({
      where: { id },
    });

    if (!dbAccount) {
      return null;
    }

    return {
      id: dbAccount.id,
      name: dbAccount.name,
      stel_ssid: dbAccount.stel_ssid,
      stel_token: dbAccount.stel_token,
      stel_ton_token: dbAccount.stel_ton_token,
      stel_hash: dbAccount.stel_hash ?? undefined,
    };
  }

  async getAllAccounts(): Promise<
    Array<{
      id: string;
      name: string;
      is_active: boolean;
      created_at: Date;
      queue_count: number;
    }>
  > {
    const accounts = await this.prisma.fragmentAccount.findMany({
      orderBy: { created_at: 'asc' },
      include: {
        _count: {
          select: {
            fragment_queue: {
              where: {
                status: { in: ['PENDING', 'PROCESSING'] },
              },
            },
          },
        },
      },
    });

    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      is_active: a.is_active,
      created_at: a.created_at,
      queue_count: a._count.fragment_queue,
    }));
  }

  async addAccount(data: {
    name: string;
    stel_ssid: string;
    stel_token: string;
    stel_ton_token: string;
    stel_hash?: string | null;
  }): Promise<{ id: string; name: string }> {
    const account = await this.prisma.fragmentAccount.create({
      data: {
        name: data.name,
        stel_ssid: data.stel_ssid,
        stel_token: data.stel_token,
        stel_ton_token: data.stel_ton_token,
        stel_hash: data.stel_hash?.trim() || null,
        is_active: true,
      },
    });

    await this.refreshCache();

    this.logger.log(`Added Fragment account: ${account.name} (${account.id})`);

    return { id: account.id, name: account.name };
  }

  async removeAccount(id: string): Promise<boolean> {
    try {
      await this.prisma.fragmentAccount.delete({
        where: { id },
      });

      await this.refreshCache();
      this.logger.log(`Removed Fragment account: ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async toggleAccount(
    id: string,
  ): Promise<{ is_active: boolean; name: string } | null> {
    try {
      const account = await this.prisma.fragmentAccount.findUnique({
        where: { id },
      });

      if (!account) return null;

      const updated = await this.prisma.fragmentAccount.update({
        where: { id },
        data: { is_active: !account.is_active },
      });

      await this.refreshCache();

      this.logger.log(
        `Toggled Fragment account ${updated.name}: ${updated.is_active ? 'ACTIVE' : 'INACTIVE'}`,
      );

      return { is_active: updated.is_active, name: updated.name };
    } catch {
      return null;
    }
  }

  async updateAccount(
    id: string,
    data: Partial<{
      name: string;
      stel_ssid: string;
      stel_token: string;
      stel_ton_token: string;
      stel_hash: string | null;
    }>,
  ): Promise<boolean> {
    try {
      const updateData: any = { ...data };
      if (data.stel_hash !== undefined) {
        updateData.stel_hash = data.stel_hash?.trim() || null;
      }
      await this.prisma.fragmentAccount.update({
        where: { id },
        data: updateData,
      });

      await this.refreshCache();
      return true;
    } catch {
      return false;
    }
  }

  async getActiveCount(): Promise<number> {
    await this.ensureFreshCache();
    return this.cachedAccounts.length;
  }
}
