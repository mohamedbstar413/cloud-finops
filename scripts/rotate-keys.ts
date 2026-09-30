/**
 * Rotate the platform master key. Every organization's data key is re-wrapped
 * under the new key; credentials never re-encrypt, except legacy ones still
 * under the master key alone, which move to their organization's own key.
 *   OLD_ENCRYPTION_KEY=<current> ENCRYPTION_KEY=<new> npm run keys:rotate
 * Stop the web servers and workers first, then start them with the new key.
 * Safe to run again if it stops half way.
 */
import { prisma } from "../src/lib/db";
import { rotateMasterKey } from "../src/lib/tenant-crypto";

async function main() {
  const oldKey = process.env.OLD_ENCRYPTION_KEY;
  const newKey = process.env.ENCRYPTION_KEY;
  if (!oldKey || !newKey) throw new Error("Set OLD_ENCRYPTION_KEY (the current key) and ENCRYPTION_KEY (the new one)");
  if (oldKey === newKey) throw new Error("The new key is the same as the old one");
  const r = await rotateMasterKey(oldKey, newKey);
  console.log(`${r.organizations} organizations: ${r.rewrapped} data keys re-wrapped, ${r.alreadyCurrent} already on the new key, ${r.credentialsUpgraded} legacy credentials moved to per-organization keys`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
