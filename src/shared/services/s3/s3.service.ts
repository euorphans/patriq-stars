import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? 'mopsstars-snapshots-gcp';
    this.endpoint =
      process.env.S3_ENDPOINT ?? 'https://storage.googleapis.com';

    const region = process.env.S3_REGION ?? 'auto';

    this.client = new S3Client({
      region,
      endpoint: this.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
  }

  async upload(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'max-age=31536000',
      }),
    );

    const url = `${this.endpoint}/${this.bucket}/${key}`;
    this.logger.log(`Uploaded: ${url}`);
    return url;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err: any) {
      this.logger.warn(`Failed to delete ${key}: ${err.message}`);
    }
  }

  keyFromUrl(url: string): string | null {
    const primary = `${this.endpoint}/${this.bucket}/`;
    if (url.startsWith(primary)) return url.slice(primary.length);
    const vh = `https://${this.bucket}.storage.googleapis.com/`;
    if (url.startsWith(vh)) return url.slice(vh.length);
    return null;
  }
}
