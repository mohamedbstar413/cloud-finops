import { createHash, randomBytes } from "node:crypto";

/** 256-bit URL-safe random token (session cookies, invitation and password-reset links). */
export const randomToken = () => randomBytes(32).toString("base64url");

/** Tokens are stored only as their SHA-256, so a database leak does not leak live sessions or links. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
