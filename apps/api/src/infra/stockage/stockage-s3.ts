import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DUREE_URL_LECTURE_S, verifierCle, type StockageObjets } from './stockage-objets.js';

export interface OptionsS3 {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Stockage S3 compatible (MinIO, Ceph, AWS) ; lecture par URL présignée de 5 minutes. */
export class StockageS3 implements StockageObjets {
  private readonly client: S3Client;

  constructor(private readonly options: OptionsS3) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async deposer(cle: string, contenu: Buffer, typeMime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: verifierCle(cle),
        Body: contenu,
        ContentType: typeMime,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async supprimer(cle: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: verifierCle(cle) }));
  }

  async contenu(cle: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: verifierCle(cle) }),
      );
      return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  urlLecture(cle: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: verifierCle(cle) }),
      { expiresIn: DUREE_URL_LECTURE_S },
    );
  }
}
