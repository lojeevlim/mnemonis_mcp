// Dev-only identity provider stand-in: an in-memory ES256 keypair, a JWKS endpoint, and one signed access token.
// Keep it running while you use the token: the server fetches the public key from this process.
//   npm run dev:jwt -- --email you@example.test [--sub dev-you] [--name "Your Name"]
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

if (process.env.NODE_ENV === "production") {
  console.error("dev-issuer refuses to run with NODE_ENV=production: it is an unauthenticated token minter for local development only.");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    sub: { type: "string" },
    name: { type: "string" },
    port: { type: "string" },
  },
});
const email = values.email;
if (!email) {
  console.error('Usage: npm run dev:jwt -- --email you@example.test [--sub <subject>] [--name "Display Name"] [--port 9999]');
  process.exit(1);
}
const port = Number.parseInt(values.port ?? "9999", 10);
const issuer = process.env.AUTH_ISSUER || `http://127.0.0.1:${port}`;
const audience = process.env.AUTH_AUDIENCE || "authenticated";
const sub = values.sub || `dev-${email.toLowerCase()}`;
const kid = "dev-1";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }] };

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/.well-known/jwks.json") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(jwks));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

const token = await new SignJWT({
  role: "authenticated",
  email,
  email_verified: true,
  ...(values.name ? { user_metadata: { full_name: values.name } } : {}),
})
  .setProtectedHeader({ alg: "ES256", kid })
  .setSubject(sub)
  .setIssuer(issuer)
  .setAudience(audience)
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(privateKey);

console.error(`Dev issuer serving http://127.0.0.1:${port}/.well-known/jwks.json (Ctrl+C to stop; the key dies with this process).`);
console.error("Run the server against it (SUPABASE_URL takes precedence over AUTH_*, so unset it):");
console.error(`  set -a; . ./.env; set +a; unset SUPABASE_URL`);
console.error(`  AUTH_ISSUER=${issuer} AUTH_JWKS_URL=http://127.0.0.1:${port}/.well-known/jwks.json AUTH_AUDIENCE=${audience} \\`);
console.error(`  MNEMONIS_SIGNUP_MODE=open npm run dev   # or allowlist + MNEMONIS_ALLOWED_EMAILS; closed needs a pre-existing user`);
console.error("\nAccess token (valid 1 hour), use as `Authorization: Bearer <token>` on /api/*:\n");
console.log(token);
