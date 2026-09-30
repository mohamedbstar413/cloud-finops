import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "./crypto";
import { prisma } from "./db";

/**
 * Per-tenant envelope encryption. Each organization has its own random 256-bit
 * data key; cloud credentials are encrypted with it (AES-256-GCM). The data key
 * itself is stored wrapped by the platform master key (ENCRYPTION_KEY), so:
 *  - one organization's key never decrypts another's credentials;
 *  - rotating the master key only re-wraps small data keys (rotateMasterKey, `npm run keys:rotate`);
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

function seal(key: Buffer, orgId: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(orgId)); // a blob copied to another organization will not decrypt
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v2", orgId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export async function encryptForOrg(orgId: string, value: unknown): Promise<string> {
  return seal(await dataKey(orgId), orgId, value);
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

/** Decrypt a master-key blob with the old key, or with the new one if an earlier run already moved it. */
function unwrapEither<T>(blob: string, oldKey: string | undefined, newKey: string | undefined, what: string): { value: T; current: boolean } {
  try {
    return { value: decryptJson<T>(blob, oldKey), current: false };
  } catch {
    try {
      return { value: decryptJson<T>(blob, newKey), current: true };
    } catch {
      throw new Error(`Neither the old nor the new master key decrypts ${what}`);
    }
  }
}

/**
 * Move every organization from the old master key to the new one: re-wrap each
 * data key, and move credentials still under the master key alone ("v1") to the
 * organization's own key. Each organization is updated in one transaction, and
 * a run that stopped half way can simply be run again.
 */
export async function rotateMasterKey(oldKey: string | undefined, newKey: string | undefined) {
  const result = { organizations: 0, rewrapped: 0, alreadyCurrent: 0, credentialsUpgraded: 0 };
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, dataKey: true, accounts: { where: { credentials: { startsWith: "v1." } }, select: { id: true, name: true, credentials: true } } },
  });
  for (const org of orgs) {
    if (!org.dataKey && org.accounts.length === 0) continue;
    result.organizations++;
    let key: Buffer;
    let wrapped: string | undefined;
    if (org.dataKey) {
      const { value, current } = unwrapEither<string>(org.dataKey, oldKey, newKey, `the data key of ${org.name} (${org.id})`);
      key = Buffer.from(value, "base64");
      if (current) result.alreadyCurrent++;
      else wrapped = encryptJson(value, newKey);
    } else {
      key = randomBytes(32);
      wrapped = encryptJson(key.toString("base64"), newKey);
    }
    if (wrapped) result.rewrapped++;
    const accounts = org.accounts.map((a) => ({
      id: a.id,
      credentials: seal(key, org.id, unwrapEither(a.credentials!, oldKey, newKey, `the credentials of ${org.name} / ${a.name} (${a.id})`).value),
    }));
    await prisma.$transaction([
      ...(wrapped ? [prisma.organization.update({ where: { id: org.id }, data: { dataKey: wrapped } })] : []),
      ...accounts.map((a) => prisma.cloudAccount.update({ where: { id: a.id }, data: { credentials: a.credentials } })),
    ]);
    result.credentialsUpgraded += accounts.length;
  }
  forgetOrgKey();
  return result;
}
