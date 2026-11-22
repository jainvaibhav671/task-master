import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// Disk storage for development and single-instance setups. Several instances
// can share it only if the directory is on a shared volume.
export const createLocalDriver = (dir) => {
  const root = path.resolve(dir);
  fs.mkdirSync(path.join(root, 'attachments'), { recursive: true });
  // Keys are generated server-side, but resolve defensively anyway.
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  };

  return {
    async write(key, stream) {
      const target = resolve(key);
      let size = 0;
      stream.on('data', (chunk) => (size += chunk.length));
      await pipeline(stream, fs.createWriteStream(target));
      return size;
    },
    async remove(key) {
      await fs.promises.unlink(resolve(key)).catch(() => {});
    },
    async sendDownload(res, attachment) {
      res.download(resolve(attachment.storageKey), attachment.originalName, {
        headers: { 'Content-Type': attachment.mimeType },
      });
    },
    async ready() {
      await fs.promises.access(root, fs.constants.W_OK);
    },
  };
};
