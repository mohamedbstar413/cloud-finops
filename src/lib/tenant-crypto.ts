import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "./crypto";
import { prisma } from "./db";

/**
 * Per-tenant envelope encryption. Each organization has its own random 256-bit
 * data key; cloud credentials are encrypted with it (AES-256-GCM). The data key
 * itself is stored wrapped by the platform master key (ENCRYPTION_KEY), so:
 *  - one organization's key never decrypts another's credentials;
 *  - rotating the master key only re-wraps small data keys (scripts/rotate-keys.ts);
 *  - deleting an organization destroys its key, and with it every copy of its secrets.
 * Blobs are tagged "v2.<orgId>.…"; legacy "v1" blobs (master key only) still decrypt.
 */

const cache = new Map<string, Buffer>();

async function dataKey(orgId: string): Promise<Buffer> {
  const hit = cache.get(orgId);
  if (hit) return hit;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { dataKey: true } });
  if (!org) throw new Error("Unknown organization");
  let key: Buffer;
  if (org.dataKey) key = Buffer.from(decryptJson<string>(org.dataKey), "base64");
  else {
    key = randomBytes(32);
    // Only set it if nobody else did in the meantime; then read back whichever won.
    await prisma.organization.updateMany({ where: { id: orgId, dataKey: null }, data: { dataKey: encryptJson(key.toString("base64")) } });
    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { dataKey: true } });
    key = Buffer.from(decryptJson<string>(stored.dataKey!), "base64");
  }
  cache.set(orgId, key);
  return key;
}

export async function encryptForOrg(orgId: string, value: unknown): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await dataKey(orgId), iv);
  cipher.setAAD(Buffer.from(orgId)); // a blob copied to another organization will not decrypt
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v2", orgId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export async function decryptForOrg<T>(orgId: string, blob: string): Promise<T> {
  if (blob.startsWith("v1.")) return decryptJson<T>(blob);
  const [v, owner, iv, tag, data] = blob.split(".");
  if (v !== "v2") throw new Error("Unsupported credential envelope");
  if (owner !== orgId) throw new Error("Credential belongs to another organization");
  const decipher = createDecipheriv("aes-256-gcm", await dataKey(orgId), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(orgId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")) as T;
}

/** Forget cached keys (after deletion or master-key rotation). */
export const forgetOrgKey = (orgId?: string) => (orgId ? cache.delete(orgId) : cache.clear());
