import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Config } from "../config.js";

/** The subset of a verified access token the app relies on. */
export interface JwtClaims {
  sub: string;
  email?: string;
  emailVerified: boolean;
  /** user_metadata.full_name or .name, when present as strings. */
  fullName?: string;
  name?: string;
}

/**
 * Issuer matching is exact string equality with cfg.authIssuer (jose): a token whose `iss` differs by a
 * trailing slash is rejected. Config derives the issuer from the SUPABASE_URL origin without a trailing slash.
 * `emailVerified` reflects only the top-level `email_verified` claim; Supabase "Confirm email" must be on
 * for allowlist/open signup to be safe.
 */
export interface JwtVerifier {
  /**
   * Verified claims, or null when the credential is bad (callers must not distinguish reasons). Throws when the
   * key source is unavailable (JWKS timeout, network error, non-200, malformed key set): that is not a credential
   * problem and callers should answer 503.
   */
  verify(token: string): Promise<JwtClaims | null>;
}

export interface JwtVerifierOptions {
  /** Key resolver override (tests). Defaults to a remote JWKS fetched from cfg.authJwksUrl. */
  keyResolver?: JWTVerifyGetKey;
}

const MAX_TOKEN_CHARS = 8192;
const MAX_SUB_CHARS = 128;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function toClaims(p: JWTPayload): JwtClaims | null {
  if (typeof p.sub !== "string" || p.sub.length === 0 || p.sub.length > MAX_SUB_CHARS) return null;
  if (p.is_anonymous === true) return null;
  if (p.role !== undefined && p.role !== "authenticated") return null;
  const meta = p.user_metadata && typeof p.user_metadata === "object" ? (p.user_metadata as Record<string, unknown>) : {};
  return {
    sub: p.sub,
    email: str(p.email),
    // Only the top-level claim counts: user_metadata is client-writable and must never establish verification.
    emailVerified: p.email_verified === true,
    fullName: str(meta.full_name),
    name: str(meta.name),
  };
}

/** jose error codes that mean "this token is bad" (as opposed to "we could not reach/read the key set"). */
const CREDENTIAL_ERROR_CODES = new Set<string>([
  errors.JWTExpired.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWSInvalid.code,
  errors.JWTInvalid.code,
  errors.JWEInvalid.code,
  errors.JWEDecryptionFailed.code,
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
  errors.JWKSNoMatchingKey.code, // unknown kid: a refusal
  errors.JWKSMultipleMatchingKeys.code,
]);

function isCredentialProblem(e: unknown): boolean {
  if (e instanceof errors.JOSEError) return CREDENTIAL_ERROR_CODES.has(e.code);
  // A fetch failure is a TypeError carrying a `cause`; a TypeError without one comes from malformed input.
  return e instanceof TypeError && e.cause === undefined;
}

export function createJwtVerifier(cfg: Pick<Config, "authIssuer" | "authJwksUrl" | "authAudience" | "authAlgs">, opts: JwtVerifierOptions = {}): JwtVerifier {
  // Only the configured JWKS URL is ever fetched; jku/x5u/embedded jwk headers are never consulted.
  const keys: JWTVerifyGetKey =
    opts.keyResolver ??
    createRemoteJWKSet(new URL(cfg.authJwksUrl), { timeoutDuration: 3000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  return {
    async verify(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: cfg.authIssuer,
          audience: cfg.authAudience,
          algorithms: cfg.authAlgs,
          clockTolerance: 5,
          requiredClaims: ["sub", "exp"],
        });
        return toClaims(payload);
      } catch (e) {
        if (isCredentialProblem(e)) return null;
        throw e; // JWKS outage / network / malformed remote key set: the caller reports 503, not 401
      }
    },
  };
}
