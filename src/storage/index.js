import crypto from 'node:crypto';
import { config } from '../config.js';
import { createLocalDriver } from './local.js';
import { createS3Driver } from './s3.js';

// A driver stores attachment bytes by key and knows how to hand them back:
//   write(key, readableStream, mimeType) -> Promise<size in bytes>
//   remove(key)                          -> Promise<void>
//   sendDownload(res, attachment)        -> streams it, or redirects to a signed URL
//   ready()                              -> Promise<void>, for readiness checks
export const storage =
  config.storage.driver === 's3' ? createS3Driver(config.storage.s3) : createLocalDriver(config.storage.localDir);

// Multer storage engine that streams the upload straight to the driver, so a
// file is never buffered whole in memory.
export const multerEngine = {
  _handleFile(_req, file, cb) {
    const key = `attachments/${crypto.randomUUID()}`;
    storage
      .write(key, file.stream, file.mimetype)
      .then((size) => cb(null, { key, size }))
      .catch(cb);
  },
  _removeFile(_req, file, cb) {
    storage.remove(file.key).then(() => cb(null), cb);
  },
};
