import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const ISSUER = "https://test.example/auth/v1";
export const AUDIENCE = "authenticated";

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function makeKey(kid: string, alg = "ES256"): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, privateKey, publicJwk };
}

export const resolverFor = (...keys: TestKey[]): JWTVerifyGetKey => createLocalJWKSet({ keys: keys.map((k) => k.publicJwk) });

export interface SignOptions {
  alg?: string;
  issuer?: string;
  audience?: string;
  /** Seconds relative to now; default +300. */
  exp?: number;
  nbf?: number;
  omitSub?: boolean;
}

export async function signToken(key: TestKey, claims: JWTPayload = {}, o: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ role: "authenticated", ...claims })
    .setProtectedHeader({ alg: o.alg ?? "ES256", kid: key.kid })
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.exp ?? 300));
  if (!o.omitSub) jwt.setSubject(claims.sub ?? "user-1");
  if (o.nbf !== undefined) jwt.setNotBefore(now + o.nbf);
  return jwt.sign(key.privateKey);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Unsigned token with alg "none". */
export function unsignedToken(claims: JWTPayload, kid: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT", kid })}.${b64({ iss: ISSUER, aud: AUDIENCE, role: "authenticated", exp: now + 300, ...claims })}.`;
}
