import { Injectable, OnModuleInit } from '@nestjs/common';
import { RapiraService } from '@/shared/services/rapira/rapira.service';
import { PrismaService } from '@/shared/services/prisma/prisma.service';

interface PriceCalculation {
  amount_rub: number;
  amount_usd: number;
  usd_rate: number;
  payment_fee_percent: number;
  service_markup_percent: number;
  purchase_price_usd: number;
  net_profit_rub: number;
}

interface PriceBreakdown {
  freekassa: { rub: number; usd: number; rate: number };
  heleket: { rub: number; usd: number; rate: number };
  ton: { rub: number; usd: number; rate: number };
}

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly STAR_PRICE_USD: number;

  private readonly PREMIUM_PRICES = {
    3: 11.99,
    6: 15.99,
    12: 28.99,
  };

  private feesCache = new Map<string, { value: number; expires: number }>();
  private markupsCache = new Map<string, { value: number; expires: number }>();
  private readonly FEES_CACHE_TTL = 60000;

  constructor(
    private readonly rapiraService: RapiraService,
    private readonly prisma: PrismaService,
  ) {
    this.STAR_PRICE_USD = parseFloat(process.env.STAR_PRICE_USD || '0.015');
  }

  async onModuleInit() {
    await this.initializeDefaultSettings();
  }

  async getBasePriceUsd(
    productType: string,
    quantity: number,
  ): Promise<number> {
    switch (productType.toLowerCase()) {
      case 'stars':
        return quantity * this.STAR_PRICE_USD;

      case 'premium':
        return this.PREMIUM_PRICES[quantity] || 0;

      case 'ton':
        return await this.rapiraService.tonToUsd(quantity);

      default:
        throw new Error(`Unknown product type: ${productType}`);
    }
  }

  private calculateRubSbpPrice(
    basePriceUsd: number,
    serviceMarkupPercent: number,
    paymentFeePercent: number,
    usdRate: number,
  ): { rub: number; usd: number; rate: number } {
    const usdRateWith2Percent = usdRate * 1.02;

    const purchasePriceRub = basePriceUsd * usdRateWith2Percent;

    const withMarkupRub = purchasePriceRub * (1 + serviceMarkupPercent / 100);

    const finalRub = withMarkupRub * (1 + paymentFeePercent / 100);

    const finalUsd = basePriceUsd * (1 + serviceMarkupPercent / 100);

    return {
      rub: Math.round(finalRub * 100) / 100,
      usd: Math.round(finalUsd * 100) / 100,
      rate: usdRateWith2Percent,
    };
  }

  private calculateHeleketPrice(
    basePriceUsd: number,
    serviceMarkupPercent: number,
    paymentFeePercent: number,
    usdRate: number,
  ): { rub: number; usd: number; rate: number } {
    const withMarkup = basePriceUsd * (1 + serviceMarkupPercent / 100);

    const finalUsd = withMarkup * (1 + paymentFeePercent / 100);

    const finalRub = finalUsd * usdRate;

    return {
      rub: Math.round(finalRub * 100) / 100,
      usd: Math.round(finalUsd * 100) / 100,
      rate: usdRate,
    };
  }

  private calculateTonPrice(
    basePriceUsd: number,
    serviceMarkupPercent: number,
    usdRate: number,
  ): { rub: number; usd: number; rate: number } {
    const finalUsd = basePriceUsd * (1 + serviceMarkupPercent / 100);

    const finalRub = finalUsd * usdRate;

    return {
      rub: Math.round(finalRub * 100) / 100,
      usd: Math.round(finalUsd * 100) / 100,
      rate: usdRate,
    };
  }

  private async getPaymentFee(paymentSystem: string): Promise<number> {
    const key = paymentSystem.toUpperCase();
    const cached = this.feesCache.get(key);
    if (cached && Date.now() < cached.expires) {
      return cached.value;
    }

    const fee = await this.prisma.paymentFee.findUnique({
      where: { payment_system: key },
    });
    const value = fee ? Number(fee.fee_percent) : 0;

    this.feesCache.set(key, {
      value,
      expires: Date.now() + this.FEES_CACHE_TTL,
    });
    return value;
  }

  private async getServiceMarkup(paymentSystem: string): Promise<number> {
    const key = paymentSystem.toUpperCase();
    const cached = this.markupsCache.get(key);
    if (cached && Date.now() < cached.expires) {
      return cached.value;
    }

    const markup = await this.prisma.serviceMarkup.findUnique({
      where: { payment_system: key },
    });
    const value = markup ? Number(markup.markup_percent) : 0;

    this.markupsCache.set(key, {
      value,
      expires: Date.now() + this.FEES_CACHE_TTL,
    });
    return value;
  }

  clearFeesCache(): void {
    this.feesCache.clear();
    this.markupsCache.clear();
  }

  async calculatePriceForPaymentSystem(
    productType: string,
    quantity: number,
    paymentSystem: string,
  ): Promise<{ rub: number; usd: number; rate: number }> {
    const [basePriceUsd, serviceMarkup, paymentFee, usdRate] =
      await Promise.all([
        this.getBasePriceUsd(productType, quantity),
        this.getServiceMarkup(paymentSystem),
        this.getPaymentFee(paymentSystem),
        this.rapiraService.getUsdtToRubRate(),
      ]);

    switch (paymentSystem.toLowerCase()) {
      case 'sbp':
      case 'freekassa':
        return this.calculateRubSbpPrice(
          basePriceUsd,
          serviceMarkup,
          paymentFee,
          usdRate,
        );

      case 'heleket':
      case 'crypto':
        return this.calculateHeleketPrice(
          basePriceUsd,
          serviceMarkup,
          paymentFee,
          usdRate,
        );

      case 'ton':
        return this.calculateTonPrice(basePriceUsd, serviceMarkup, usdRate);

      default:
        throw new Error(`Unknown payment system: ${paymentSystem}`);
    }
  }

  async calculatePriceForPaymentSystemDetailed(
    productType: string,
    quantity: number,
    paymentSystem: string,
  ): Promise<PriceCalculation> {
    const [basePriceUsd, serviceMarkup, paymentFeeValue, usdRate] =
      await Promise.all([
        this.getBasePriceUsd(productType, quantity),
        this.getServiceMarkup(paymentSystem),
        this.getPaymentFee(paymentSystem),
        this.rapiraService.getUsdtToRubRate(),
      ]);
    let paymentFee = paymentFeeValue;

    let result: { rub: number; usd: number; rate: number };

    switch (paymentSystem.toLowerCase()) {
      case 'sbp':
      case 'freekassa':
        result = this.calculateRubSbpPrice(
          basePriceUsd,
          serviceMarkup,
          paymentFee,
          usdRate,
        );
        break;

      case 'heleket':
      case 'crypto':
        result = this.calculateHeleketPrice(
          basePriceUsd,
          serviceMarkup,
          paymentFee,
          usdRate,
        );
        break;

      case 'ton':
        result = this.calculateTonPrice(basePriceUsd, serviceMarkup, usdRate);
        paymentFee = 0;
        break;

      default:
        throw new Error(`Unknown payment system: ${paymentSystem}`);
    }

    const markupProfitUsd = basePriceUsd * (serviceMarkup / 100);

    const netProfitUsd = markupProfitUsd;
    const netProfitRub = Math.round(netProfitUsd * result.rate * 100) / 100;

    return {
      amount_rub: result.rub,
      amount_usd: result.usd,
      usd_rate: result.rate,
      payment_fee_percent: paymentFee,
      service_markup_percent: serviceMarkup,
      purchase_price_usd: basePriceUsd,
      net_profit_rub: netProfitRub,
    };
  }

  async getAllPricesForProduct(
    productType: string,
    quantity: number,
  ): Promise<PriceBreakdown> {
    const [freekassa, heleket, ton] = await Promise.all([
      this.calculatePriceForPaymentSystem(productType, quantity, 'freekassa'),
      this.calculatePriceForPaymentSystem(productType, quantity, 'heleket'),
      this.calculatePriceForPaymentSystem(productType, quantity, 'ton'),
    ]);

    return { freekassa, heleket, ton };
  }

  async initializeDefaultSettings(): Promise<void> {
    const defaultFees = {
      freekassa: 6.0,
      heleket: 2.0,
      ton: 0.0,
    };

    const defaultMarkups = {
      freekassa: 13.0,
      heleket: 13.0,
      ton: 13.0,
    };

    for (const [system, fee] of Object.entries(defaultFees)) {
      const systemUpper = system.toUpperCase();
      const existing = await this.prisma.paymentFee.findUnique({
        where: { payment_system: systemUpper },
      });
      if (!existing) {
        await this.prisma.paymentFee.create({
          data: {
            payment_system: systemUpper,
            fee_percent: fee,
          },
        });
      }
    }

    for (const [system, markup] of Object.entries(defaultMarkups)) {
      const systemUpper = system.toUpperCase();
      const existing = await this.prisma.serviceMarkup.findUnique({
        where: { payment_system: systemUpper },
      });
      if (!existing) {
        await this.prisma.serviceMarkup.create({
          data: {
            payment_system: systemUpper,
            markup_percent: markup,
          },
        });
      }
    }
  }
}
