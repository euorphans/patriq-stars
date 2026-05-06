import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/** Единственный поддерживаемый язык интерфейса бота. */
export type SupportedLanguage = 'ru';

interface Translations {
  [key: string]: string;
}

@Injectable()
export class I18nService {
  private readonly logger = new Logger(I18nService.name);
  private translations: Map<SupportedLanguage, Translations> = new Map();
  private translationCache: Map<string, string> = new Map();
  private readonly CACHE_SIZE_LIMIT = 1000;

  constructor() {
    this.loadTranslations();
  }

  private loadTranslations(): void {
    const lang: SupportedLanguage = 'ru';
    try {
      let translations: any;
      let filePath: string;

      const distPath = path.join(__dirname, 'locales', `${lang}.json`);

      const srcPath = path.resolve(
        process.cwd(),
        'src',
        'shared',
        'services',
        'i18n',
        'locales',
        `${lang}.json`,
      );

      const distPathRelative = path.resolve(
        process.cwd(),
        'dist',
        'shared',
        'services',
        'i18n',
        'locales',
        `${lang}.json`,
      );

      if (fs.existsSync(distPath)) {
        filePath = distPath;
        this.logger.debug(`Using dist path: ${distPath}`);
      } else if (fs.existsSync(distPathRelative)) {
        filePath = distPathRelative;
        this.logger.debug(`Using relative dist path: ${distPathRelative}`);
      } else if (fs.existsSync(srcPath)) {
        filePath = srcPath;
        this.logger.debug(`Using src path: ${srcPath}`);
      } else {
        this.logger.error(`Translation file not found for ${lang} in:`);
        this.logger.error(`  - ${distPath}`);
        this.logger.error(`  - ${distPathRelative}`);
        this.logger.error(`  - ${srcPath}`);
        throw new Error(
          `Translation file not found for ${lang} in both dist and src folders`,
        );
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      translations = JSON.parse(fileContent);

      const flattened = this.flattenObject(translations);
      this.translations.set(lang, flattened);
      this.logger.log(
        `Loaded translations for ${lang} from ${filePath} (${Object.keys(flattened).length} keys)`,
      );

      const criticalKeys = [
        'menu.main.stars',
        'menu.main.premium',
        'menu.main.ton',
        'menu.main.profile',
        'menu.main.support',
      ];
      const missingKeys = criticalKeys.filter((key) => !flattened[key]);
      if (missingKeys.length > 0) {
        this.logger.warn(
          `Missing critical keys for ${lang}: ${missingKeys.join(', ')}`,
        );
      } else {
        this.logger.log(`All critical keys present for ${lang}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to load translations for ${lang}: ${error.message}`,
      );
      this.translations.set(lang, {});
    }
  }

  private flattenObject(obj: any, prefix: string = ''): Translations {
    const result: Translations = {};

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const newKey = prefix ? `${prefix}.${key}` : key;
        const value = obj[key];

        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          Object.assign(result, this.flattenObject(value, newKey));
        } else {
          result[newKey] = String(value);
        }
      }
    }

    return result;
  }

  /**
   * Второй аргумент исторически был код языка — игнорируется, строки всегда из ru.json.
   */
  t(
    key: string,
    _lang?: SupportedLanguage,
    params?: Record<string, string | number>,
  ): string {
    const translations = this.translations.get('ru');
    if (!translations) {
      return key;
    }

    const applyParams = (raw: string): string =>
      raw.replace(/\{(\w+)\}/g, (match, param) => {
        const value = params?.[param];
        return value !== undefined ? String(value) : match;
      });

    if (!params || Object.keys(params).length === 0) {
      const cacheKey = `ru:${key}`;
      const cached = this.translationCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const text = translations[key];
      if (!text) {
        if (process.env.NODE_ENV !== 'production') {
          this.logger.warn(`Translation key '${key}' not found`);
        }
        return key;
      }

      if (this.translationCache.size < this.CACHE_SIZE_LIMIT) {
        this.translationCache.set(cacheKey, text);
      }

      return text;
    }

    const text = translations[key];
    if (!text) {
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn(`Translation key '${key}' not found`);
      }
      return key;
    }

    return applyParams(text);
  }

  getSupportedLanguages(): SupportedLanguage[] {
    return ['ru'];
  }

  getLanguageName(_lang: SupportedLanguage): string {
    return 'Русский';
  }
}
