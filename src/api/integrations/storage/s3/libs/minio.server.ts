import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol,
  type UserDelegationKey,
} from '@azure/storage-blob';
import { AzureBlobStorage, ConfigService, S3 } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import * as MinIo from 'minio';
import { posix } from 'path';
import { Readable, Transform } from 'stream';

const logger = new Logger('Media Storage');
const config = new ConfigService();
const BUCKET = config.get<S3>('S3');
const AZURE_BLOB = config.get<AzureBlobStorage>('AZURE_BLOB');
interface Metadata extends MinIo.ItemBucketMetadata { 'Content-Type': string }

const useAzure = AZURE_BLOB?.ENABLED === true;
if (useAzure && !AZURE_BLOB.ACCOUNT_NAME) {
  throw new Error('AZURE_BLOB_ACCOUNT_NAME is required when MEDIA_STORAGE_PROVIDER=azure');
}
const azure = (() => {
  if (!useAzure) return undefined;
  const endpoint = AZURE_BLOB.ENDPOINT || `https://${AZURE_BLOB.ACCOUNT_NAME}.blob.core.windows.net`;
  const service = new BlobServiceClient(endpoint, new DefaultAzureCredential());
  return { service, container: service.getContainerClient(AZURE_BLOB.CONTAINER_NAME) };
})();
const minio = (() => {
  if (BUCKET?.ENABLE && !useAzure) return new MinIo.Client({
    endPoint: BUCKET.ENDPOINT, port: BUCKET.PORT, useSSL: BUCKET.USE_SSL,
    accessKey: BUCKET.ACCESS_KEY, secretKey: BUCKET.SECRET_KEY, region: BUCKET.REGION,
  });
})();
const bucketName = BUCKET.BUCKET_NAME;
const clockSkewMs = 5 * 60 * 1000;
const maxDelegationKeyMs = 7 * 24 * 60 * 60 * 1000;
const defaultSasSeconds = maxDelegationKeyMs / 1000 - 10 * 60;
let delegationKey: { key: UserDelegationKey; expiresOn: Date } | undefined;

const objectName = (...parts: string[]) => {
  const normalizedParts = parts.map(part => part.replace(/\\/g, '/'));
  if (normalizedParts.some(part => part.startsWith('/') || part.split('/').includes('..'))) {
    throw new Error('Invalid media object name');
  }
  const name = posix.normalize(posix.join(...normalizedParts));
  if (!name || name === '.' || name === '..' || name.startsWith('../') || name.startsWith('/')) {
    throw new Error('Invalid media object name');
  }
  return name;
};

const getDelegationKey = async () => {
  if (!azure) throw new Error('Azure Blob Storage is not configured');
  const now = Date.now();
  if (delegationKey && delegationKey.expiresOn.getTime() > now + clockSkewMs) return delegationKey;
  const startsOn = new Date(now - clockSkewMs);
  const expiresOn = new Date(startsOn.getTime() + maxDelegationKeyMs);
  const key = await azure.service.getUserDelegationKey(startsOn, expiresOn);
  delegationKey = { key, expiresOn };
  return delegationKey;
};

const uploadOptions = (metadata: Metadata) => {
  const headers: Record<string, string> = {};
  const custom: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata || {})) {
    if (typeof value !== 'string') continue;
    switch (name.toLowerCase()) {
      case 'content-type': headers['blobContentType'] = value; break;
      case 'cache-control': headers['blobCacheControl'] = value; break;
      case 'content-encoding': headers['blobContentEncoding'] = value; break;
      case 'content-language': headers['blobContentLanguage'] = value; break;
      case 'content-disposition': headers['blobContentDisposition'] = value; break;
      default: {
        const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        custom[/^[a-z_]/.test(key) ? key : `_${key}`] = value;
      }
    }
  }
  if (!headers.blobContentType) headers.blobContentType = 'application/octet-stream';
  return { blobHTTPHeaders: headers, metadata: custom };
};
const uploadAzure = async (name: string, file: Buffer | Transform | Readable, metadata: Metadata) => {
  if (!azure) return undefined;
  const blockBlob = azure.container.getBlockBlobClient(name);
  const options = uploadOptions(metadata);
  return Buffer.isBuffer(file)
    ? blockBlob.uploadData(file, options)
    : blockBlob.uploadStream(file as Readable, 4 * 1024 * 1024, 5, options);
};

const bucketExists = async () => {
  if (!minio) return undefined;
  try { return (await minio.listBuckets()).find(bucket => bucket.name === bucketName); }
  catch { return false; }
};
const setBucketPolicy = async () => {
  if (!minio) return;
  await minio.setBucketPolicy(bucketName, JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucketName}/*`] }],
  }));
};
const createBucket = async () => {
  if (azure) {
    try {
      await azure.container.createIfNotExists();
      logger.info(`Azure Blob container ${AZURE_BLOB.CONTAINER_NAME} - ON`);
      return true;
    } catch (error) { logger.error('AZURE BLOB STORAGE ERROR:'); logger.error(error); return false; }
  }
  if (minio) {
    try {
      if (!(await bucketExists())) await minio.makeBucket(bucketName);
      if (!BUCKET.SKIP_POLICY) await setBucketPolicy();
      logger.info(`S3 Bucket ${bucketName} - ON`);
      return true;
    } catch (error) { logger.error('S3 ERROR:'); logger.error(error); return false; }
  }
};
void createBucket();

const uploadFile = async (fileName: string, file: Buffer | Transform | Readable, size: number, metadata: Metadata) => {
  const name = objectName('evolution-api', fileName);
  try {
    metadata['custom-header-application'] = 'evolution-api';
    if (azure) return await uploadAzure(name, file, metadata);
    if (minio) return await minio.putObject(bucketName, name, file, size, metadata);
  } catch (error) { logger.error(error); return error; }
};
const getObjectUrl = async (fileName: string, expiry?: number) => {
  const name = objectName('evolution-api', fileName);
  try {
    if (azure) {
      const { key, expiresOn: keyExpiry } = await getDelegationKey();
      const requested = Number.isFinite(expiry) && expiry > 0 ? expiry : defaultSasSeconds;
      const expiresOn = new Date(Math.min(Date.now() + Math.max(60, requested) * 1000, keyExpiry.getTime()));
      const sas = generateBlobSASQueryParameters({
        containerName: AZURE_BLOB.CONTAINER_NAME, blobName: name,
        permissions: BlobSASPermissions.parse('r'), startsOn: new Date(Date.now() - clockSkewMs),
        expiresOn, protocol: SASProtocol.Https,
      }, key, AZURE_BLOB.ACCOUNT_NAME).toString();
      return `${azure.container.getBlobClient(name).url}?${sas}`;
    }
    if (minio) return expiry
      ? await minio.presignedGetObject(bucketName, name, expiry)
      : await minio.presignedGetObject(bucketName, name);
  } catch (error) { throw new BadRequestException(error?.message); }
};
const uploadTempFile = async (folder: string, fileName: string, file: Buffer | Transform | Readable, size: number, metadata: Metadata) => {
  const name = objectName(folder, fileName);
  try {
    metadata['custom-header-application'] = 'evolution-api';
    if (azure) return await uploadAzure(name, file, metadata);
    if (minio) return await minio.putObject(bucketName, name, file, size, metadata);
  } catch (error) { logger.error(error); return error; }
};
const deleteFile = async (folder: string, fileName: string) => {
  const name = objectName(folder, fileName);
  try {
    if (azure) return await azure.container.getBlobClient(name).deleteIfExists();
    if (minio) return await minio.removeObject(bucketName, name);
  } catch (error) { logger.error(error); return error; }
};
export { BUCKET, deleteFile, getObjectUrl, uploadFile, uploadTempFile };
