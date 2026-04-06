/**
 * R2 presigned URL generation for Git LFS.
 *
 * Uses aws4fetch AwsV4Signer to create S3-compatible presigned URLs.
 * Worker never proxies LFS data — only generates signed URLs.
 */

import { AwsV4Signer } from "aws4fetch";

function lfsKey(orgId: string, repoId: string, oid: string): string {
  return `${orgId}/${repoId}/lfs/${oid.slice(0, 2)}/${oid.slice(2)}`;
}

const LFS_BUCKET_NAME = "coregit-lfs";
const UPLOAD_TTL = 900;     // 15 minutes
const DOWNLOAD_TTL = 3600;  // 1 hour

interface PresignEnv {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
}

async function presign(
  env: PresignEnv,
  method: string,
  key: string,
  ttl: number,
): Promise<string> {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = new URL(`/${LFS_BUCKET_NAME}/${key}`, endpoint);
  url.searchParams.set("X-Amz-Expires", String(ttl));

  const signer = new AwsV4Signer({
    method,
    url: url.toString(),
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    signQuery: true,
  });

  const signed = await signer.sign();
  return signed.url.toString();
}

export async function presignUpload(
  env: PresignEnv,
  orgId: string,
  repoId: string,
  oid: string,
): Promise<{ href: string; expires_in: number }> {
  const key = lfsKey(orgId, repoId, oid);
  const href = await presign(env, "PUT", key, UPLOAD_TTL);
  return { href, expires_in: UPLOAD_TTL };
}

export async function presignDownload(
  env: PresignEnv,
  orgId: string,
  repoId: string,
  oid: string,
): Promise<{ href: string; expires_in: number }> {
  const key = lfsKey(orgId, repoId, oid);
  const href = await presign(env, "GET", key, DOWNLOAD_TTL);
  return { href, expires_in: DOWNLOAD_TTL };
}

/** Build R2 key for direct bucket operations (HEAD, DELETE). */
export function buildLfsKey(orgId: string, repoId: string, oid: string): string {
  return lfsKey(orgId, repoId, oid);
}

/** Build R2 prefix for listing/deleting all LFS objects for a repo. */
export function buildLfsPrefix(orgId: string, repoId: string): string {
  return `${orgId}/${repoId}/lfs/`;
}
