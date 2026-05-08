import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';

@Injectable()
export class LocalSnapshotStorageService {
  private readonly logger = new Logger(LocalSnapshotStorageService.name);
  private readonly root: string;

  constructor() {
    this.root = path.resolve(
      process.env.LOCAL_STORAGE_PATH ||
        path.join(process.cwd(), 'data', 'local-storage'),
    );
  }

  async upload(
    key: string,
    body: Buffer,
    _contentType: string,
  ): Promise<string> {
    const safeKey = key.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!safeKey || safeKey.includes('..')) {
      throw new Error(`Invalid storage key: ${key}`);
    }

    const dest = path.join(this.root, ...safeKey.split('/'));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body);

    const base = this.getPublicBaseUrl();
    const url = `${base}/api/local-snapshots/${safeKey}`;
    this.logger.log(`Saved snapshot: ${url}`);
    return url;
  }

  private getPublicBaseUrl(): string {
    const explicit = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    const webhook = process.env.WEBHOOK_DOMAIN?.trim().replace(/\/+$/, '');
    if (webhook) return webhook;
    const port = process.env.APPLICATION_PORT || '3001';
    return `http://127.0.0.1:${port}`;
  }
}
