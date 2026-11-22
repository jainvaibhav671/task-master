-- Attachments now live behind a storage driver (disk or S3), addressed by key.
ALTER TABLE "Attachment" RENAME COLUMN "storedName" TO "storageKey";
ALTER INDEX "Attachment_storedName_key" RENAME TO "Attachment_storageKey_key";
