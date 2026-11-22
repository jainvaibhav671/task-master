import { PassThrough } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../logger.js';

// S3 or any S3-compatible store (MinIO, R2, ...). Downloads redirect to a
// short-lived signed URL, so file bytes never pass through the API servers.
export const createS3Driver = ({ bucket, region, endpoint, publicEndpoint, forcePathStyle, downloadUrlTtl }) => {
  const client = new S3Client({ region, endpoint, forcePathStyle });
  // Signs URLs against the address clients use, which can differ from the
  // internal one (for example MinIO inside docker compose).
  const signer =
    publicEndpoint && publicEndpoint !== endpoint
      ? new S3Client({ region, endpoint: publicEndpoint, forcePathStyle })
      : client;

  let bucketChecked = null;
  const ensureBucket = () => {
    bucketChecked ??= (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (err) {
        if (process.env.S3_CREATE_BUCKET !== 'true') throw err;
        await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((e) => {
          if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
        });
        logger.info({ bucket }, 'created storage bucket');
      }
    })().catch((err) => {
      bucketChecked = null;
      throw err;
    });
    return bucketChecked;
  };

  return {
    async write(key, stream, mimeType) {
      await ensureBucket();
      let size = 0;
      const counted = new PassThrough();
      counted.on('data', (chunk) => (size += chunk.length));
      stream.pipe(counted);
      await new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: counted, ContentType: mimeType },
      }).done();
      return size;
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch((err) => {
        logger.warn({ err, key }, 'failed to delete stored object');
      });
    },
    async sendDownload(res, attachment) {
      const url = await getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket: bucket,
          Key: attachment.storageKey,
          ResponseContentType: attachment.mimeType,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
        }),
        { expiresIn: downloadUrlTtl },
      );
      res.redirect(302, url);
    },
    async ready() {
      await ensureBucket();
    },
  };
};
