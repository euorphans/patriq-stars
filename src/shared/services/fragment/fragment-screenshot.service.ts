import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { S3Service } from '@/shared/services/s3/s3.service';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer-core';

export type FragmentSnapshotView = 'stars' | 'premium' | 'ton';

export interface SnapshotRow {
  username: string;
  stars: number;
  premiumMonths: number | null;
  tonAmount: number | null;
  amountTon: number | null;
  completedAt: Date;
}

export interface SnapshotParams {
  view: FragmentSnapshotView;
  paymentId: string;
  orderNumber: number;
  recipientUsername: string;
  starsAmount: number;
  premiumMonths: number | null;
  tonProductAmount: number | null;
  amountTon: number | null;
  txHash: string | null;
  completedAt: Date;
  contextRows?: SnapshotRow[];
}

@Injectable()
export class FragmentScreenshotService {
  private readonly logger = new Logger(FragmentScreenshotService.name);
  private cssCache: string | null = null;
  private fontRegularBase64: string | null = null;
  private fontBoldBase64: string | null = null;

  private browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  private browserLaunchPromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  private async getBrowser(): Promise<
    Awaited<ReturnType<typeof puppeteer.launch>>
  > {
    if (this.browser) {
      try {
        await this.browser.pages();
        return this.browser;
      } catch {
        this.browser = null;
      }
    }

    if (this.browserLaunchPromise) {
      await this.browserLaunchPromise;
      return this.browser!;
    }

    this.browserLaunchPromise = (async () => {
      const chromiumPaths = [
        process.env.CHROMIUM_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ].filter(Boolean) as string[];

      const executablePath = chromiumPaths.find((p) => fs.existsSync(p));
      if (!executablePath) {
        this.logger.warn('Chromium not found, falling back to HTML storage');
        return;
      }

      this.browser = await puppeteer.launch({
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--hide-scrollbars',
        ],
        headless: true,
      });

      this.logger.log('Puppeteer browser launched (persistent)');
    })();

    await this.browserLaunchPromise;
    this.browserLaunchPromise = null;
    return this.browser!;
  }

  private loadCss(): string {
    if (this.cssCache) return this.cssCache;

    const dirs = [
      path.join(process.cwd(), 'fragment-assets'),
      path.join(process.cwd(), '..', 'fragment', 'Fragment_files'),
    ];

    const files = ['bootstrap.min.css', 'bootstrap-extra.css', 'auction.css'];
    let css = '';

    const baseDir = dirs.find((d) => fs.existsSync(d)) || dirs[0];

    for (const file of files) {
      const filePath = path.join(baseDir, file);
      try {
        css += fs.readFileSync(filePath, 'utf-8') + '\n';
      } catch {
        this.logger.warn(`CSS file not found: ${filePath}`);
      }
    }

    this.cssCache = css;
    return css;
  }

  async captureOrderSnapshot(params: SnapshotParams): Promise<string | null> {
    try {
      const html = this.buildReceiptHtml(params);
      const screenshot = await this.screenshotHtml(html);

      let stored: string;
      if (screenshot) {
        const key = `snapshots/payments/${params.paymentId}.png`;
        const url = await this.s3.upload(key, screenshot, 'image/png');
        stored = url;
      } else {
        stored = 'html:' + html;
      }

      await this.prisma.payment.update({
        where: { id: params.paymentId },
        data: { fragment_screenshot: stored },
      });

      this.logger.log(
        `Snapshot saved for order #${params.orderNumber}: ${stored.startsWith('http') ? stored : `html(${Math.round(stored.length / 1024)}KB)`}`,
      );
      return stored;
    } catch (error: any) {
      this.logger.error(
        `Failed to capture snapshot for order #${params.orderNumber}: ${error.message}`,
      );
      return null;
    }
  }

  private formatRowDate(d: Date): { long: string; short: string } {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const inMoscow = new Date(
      d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }),
    );
    const day = inMoscow.getDate();
    const mon = months[inMoscow.getMonth()];
    const year = inMoscow.getFullYear();
    const hh = String(inMoscow.getHours()).padStart(2, '0');
    const mm = String(inMoscow.getMinutes()).padStart(2, '0');
    return {
      long: `${day} ${mon} ${year} at ${hh}:${mm}`,
      short: `${mon} ${day} at ${hh}:${mm}`,
    };
  }

  private formatPremiumDuration(months: number): string {
    if (months === 12) return '1 year';
    if (months === 1) return '1 month';
    return `${months} months`;
  }

  private priceCellHtml(amountTon: number | null): string {
    const priceStr = amountTon !== null ? String(amountTon) : '—';
    const priceParts = priceStr.includes('.')
      ? `${this.esc(priceStr.split('.')[0])}<span class="mini-frac">.${this.esc(priceStr.split('.')[1])}</span>`
      : this.esc(priceStr);
    return `<td><div class="table-cell"><div class="table-cell-value tm-value icon-before icon-ton">${priceParts}</div></div></td>`;
  }

  private buildTableRowForView(
    row: SnapshotRow,
    view: FragmentSnapshotView,
    highlight: boolean,
  ): string {
    const recipient = this.esc(
      row.username.startsWith('@') ? row.username : `@${row.username}`,
    );
    const { long, short } = this.formatRowDate(row.completedAt);
    const trClass = highlight ? ' class="tm-row-highlight"' : '';

    const dateTd = `<td><div class="table-cell"><div class="tm-datetime"><span class="thin-only"><time class="short">${this.esc(short)}</time></span><span class="wide-only"><time>${this.esc(long)}</time></span></div></div></td>`;

    if (view === 'ton') {
      const amountValue =
        row.amountTon != null && !Number.isNaN(row.amountTon)
          ? row.amountTon
          : row.tonAmount != null && row.tonAmount > 0
            ? row.tonAmount
            : null;
      return `            <tr${trClass}>
  <td><div class="table-cell"><a class="tm-inline-nowrap">${recipient}</a></div></td>
  ${this.priceCellHtml(amountValue)}
  ${dateTd}
</tr>`;
    }

    let middleTd: string;
    if (view === 'premium') {
      const months = row.premiumMonths ?? 0;
      const dur = months > 0 ? this.formatPremiumDuration(months) : '—';
      middleTd = `<td><div class="table-cell"><div class="tm-datetime"><time>${this.esc(dur)}</time></div></div></td>`;
    } else {
      const starsStr = row.stars.toLocaleString('en-US');
      middleTd = `<td><div class="table-cell"><div class="table-cell-value tm-value tm-nowrap">${starsStr}</div></div></td>`;
    }

    return `            <tr${trClass}>
  <td><div class="table-cell"><a class="tm-inline-nowrap">${recipient}</a></div></td>
  ${middleTd}
  ${this.priceCellHtml(row.amountTon)}
  ${dateTd}
</tr>`;
  }

  private headerTabsHtml(view: FragmentSnapshotView): string {
    const starsActive = view === 'stars' ? ' tab-active' : '';
    const premiumActive = view === 'premium' ? ' tab-active' : '';
    const adsActive = view === 'ton' ? ' tab-active' : '';
    return `          <a class="tm-header-tab">Usernames</a>
          <a class="tm-header-tab">Numbers</a>
          <a class="tm-header-tab">Gifts <span class="tm-label-new tm-header-tab-label-new">New</span></a>
          <a class="tm-header-tab${starsActive}">Stars</a>
          <a class="tm-header-tab${premiumActive}">Premium</a>
          <a class="tm-header-tab${adsActive}">Ads</a>`;
  }

  private sectionTabsHtml(view: FragmentSnapshotView): string {
    if (view === 'premium') {
      return `        <a class="tm-section-tab tab-active">Gifts</a>
        <a class="tm-section-tab">Giveaways</a>`;
    }
    if (view === 'ton') {
      return `        <a class="tm-section-tab">Ad Accounts</a>
        <a class="tm-section-tab tab-active">Telegram Accounts</a>`;
    }
    return `        <a class="tm-section-tab tab-active">Stars</a>
        <a class="tm-section-tab">Giveaways</a>`;
  }

  private tableHeadHtml(view: FragmentSnapshotView): string {
    if (view === 'premium') {
      return `            <tr>
              <th style="--width:30%">Recipient</th>
              <th style="--thin-width:95px;--wide-width:22%">Duration</th>
              <th style="--thin-width:70px;--wide-width:18%">Price</th>
              <th style="--thin-width:115px;--wide-width:30%">Date</th>
            </tr>`;
    }
    if (view === 'ton') {
      return `            <tr>
              <th style="--width:38%">Recipient</th>
              <th style="--thin-width:100px;--wide-width:30%">Amount</th>
              <th style="--thin-width:115px;--wide-width:32%">Date</th>
            </tr>`;
    }
    return `            <tr>
              <th style="--width:30%">Recipient</th>
              <th style="--thin-width:75px;--wide-width:25%">Stars</th>
              <th style="--thin-width:70px;--wide-width:15%">Price</th>
              <th style="--thin-width:115px;--wide-width:30%">Date</th>
            </tr>`;
  }

  private buildReceiptHtml(params: SnapshotParams): string {
    const css = this.loadCss();
    const fontStyle = this.getFontStyle();
    const view = params.view;

    const ctx = params.contextRows ?? [];
    const current: SnapshotRow = {
      username: params.recipientUsername,
      stars: params.starsAmount,
      premiumMonths: params.premiumMonths,
      tonAmount: params.tonProductAmount,
      amountTon: params.amountTon,
      completedAt: params.completedAt,
    };

    const allRows: Array<SnapshotRow & { isCurrent: boolean }> = [
      ...ctx.map((r) => ({ ...r, isCurrent: false })),
      { ...current, isCurrent: true },
    ].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

    const tableRows = allRows
      .map((row) => this.buildTableRowForView(row, view, row.isCurrent))
      .join('\n');

    const watermarkDate = params.completedAt.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Europe/Moscow',
    });

    return `<!DOCTYPE html>
<html class="header-tabs">
<head>
<meta charset="utf-8">
<style>
${fontStyle}
${css}
</style>
<style>
html, body { margin: 0; padding: 0; background: rgb(26, 32, 38); }
body { padding-top: var(--header-height) !important; }
.tm-row-highlight > td:first-child .table-cell { position: relative; }
.tm-row-highlight > td:first-child .table-cell:before {
  content: '';
  position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; background: #248bda;
  border-radius: 0 2px 2px 0;
}
.tm-header-menu { display: none !important; }
.tm-header-tab-label-new { margin-left: 4px; vertical-align: middle; }
.watermark {
  position: fixed; bottom: 16px; right: 20px;
  z-index: 99999; pointer-events: none;
  font-family: ProductSans,-apple-system,sans-serif;
  font-size: 17px; font-weight: 600; line-height: 1.4;
  text-align: right; color: rgba(255,255,255,0.35);
  letter-spacing: 0.3px;
}
.watermark span { font-weight: 400; font-size: 14px; }
</style>
</head>
<body class="emoji_image">
  <header class="tm-header with-tabs">
    <div class="tm-header-logo">
      <a class="tm-logo">
        <i class="tm-logo-icon"></i>
        <i class="tm-logo-text"></i>
      </a>
    </div>
    <div class="tm-header-body">
      <div class="tm-header-tabs-wrap">
        <div class="tm-header-tabs tm-x-scrollable">
${this.headerTabsHtml(view)}
        </div>
      </div>
    </div>
    <div class="tm-header-menu-button icon-before icon-header-menu"></div>
  </header>

  <main class="tm-main">
    <section class="tm-section clearfix">
      <div class="tm-section-header">
        <h3 class="tm-section-header-text">Transaction History</h3>
        <div class="btn-group tm-dropdown">
          <button class="btn btn-default dropdown-toggle icon-after">Newest first</button>
        </div>
      </div>
      <div class="tm-section-tabs">
${this.sectionTabsHtml(view)}
      </div>
      <div class="tm-table-wrap">
        <table class="table tm-table tm-table-fixed">
          <thead>
${this.tableHeadHtml(view)}
          </thead>
          <tfoot></tfoot>
          <tbody>
${tableRows}
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <div class="watermark">@MopsStarsBot<br><span>${this.esc(watermarkDate)}</span></div>
</body>
</html>`;
  }

  private loadFontBase64(filename: string): string | null {
    const dir = path.join(process.cwd(), 'fragment-assets', 'fonts');
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath).toString('base64');
    }
    return null;
  }

  private getFontStyle(): string {
    if (!this.fontRegularBase64) {
      this.fontRegularBase64 = this.loadFontBase64('ProductSansRegular.ttf');
    }
    if (!this.fontBoldBase64) {
      this.fontBoldBase64 = this.loadFontBase64('ProductSansBold.ttf');
    }

    const parts: string[] = [];
    if (this.fontRegularBase64) {
      parts.push(`@font-face {
  font-family: ProductSans;
  font-weight: 400;
  src: url(data:font/truetype;base64,${this.fontRegularBase64}) format('truetype');
}`);
    }
    if (this.fontBoldBase64) {
      parts.push(`@font-face {
  font-family: ProductSans;
  font-weight: 700;
  src: url(data:font/truetype;base64,${this.fontBoldBase64}) format('truetype');
}`);
    }
    return parts.join('\n');
  }

  private async screenshotHtml(html: string): Promise<Buffer | null> {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await this.getBrowser();
    } catch {
      this.logger.warn('Chromium not found, falling back to HTML storage');
      return null;
    }

    if (!browser) {
      return null;
    }

    const page = await browser.newPage();
    try {
      await page.setViewport({
        width: 1440,
        height: 720,
        deviceScaleFactor: 2,
      });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);

      const buffer = await page.screenshot({ type: 'png' });
      return Buffer.from(buffer);
    } finally {
      await page.close().catch(() => {});
    }
  }

  getHtml(stored: string): string | null {
    if (stored.startsWith('html:')) return stored.slice(5);
    return null;
  }

  private esc(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
