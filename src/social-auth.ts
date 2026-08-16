import { createHash, timingSafeEqual } from "node:crypto";
import {
  SignJWT,
  createRemoteJWKSet,
  errors,
  importPKCS8,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { z } from "zod";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5_000 });
const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"), { timeoutDuration: 5_000 });
const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());

export type SocialIdentity = {
  provider: "google" | "apple";
  subject: string;
  email?: string;
  suggestedName?: string;
  profileImageUrl?: string;
  canAutoLinkEmail: boolean;
};

export type AppleAuthInput = {
  authorizationCode: string;
  identityToken: string;
  givenName?: string;
  familyName?: string;
  platform: "ios" | "android" | "web";
  nonce?: string;
};

const invalidToken = () => new ApiError(401, "INVALID_PROVIDER_TOKEN", "The identity provider could not verify this sign-in.");
const providerUnavailable = () => new ApiError(503, "AUTH_PROVIDER_UNAVAILABLE", "The identity provider is temporarily unavailable.");
const providerNotConfigured = () => new ApiError(503, "AUTH_PROVIDER_NOT_CONFIGURED", "This sign-in method is not configured.");

const cleanSubject = (subject: unknown) => {
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 255) throw invalidToken();
  return subject;
};

const cleanEmail = (email: unknown) => {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) throw invalidToken();
  return parsed.data;
};

const cleanText = (value: unknown, max = 80) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

const verifiedClaim = (value: unknown) => value === true || value === "true";

const mapVerificationError = (error: unknown): never => {
  if (error instanceof ApiError) throw error;
  if ((error as { code?: string })?.code === "ERR_JWKS_TIMEOUT") throw providerUnavailable();
  if (error instanceof errors.JOSEError) throw invalidToken();
  throw providerUnavailable();
};

export async function verifyGoogleIdToken(idToken: string): Promise<SocialIdentity> {
  if (!config.googleClientIds.length) throw providerNotConfigured();

  try {
    const { payload } = await jwtVerify(idToken, googleKeys, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.googleClientIds,
      requiredClaims: ["sub", "email", "email_verified", "iat", "exp"],
    });
    if (!verifiedClaim(payload.email_verified)) throw invalidToken();
    if (payload.azp !== undefined && (typeof payload.azp !== "string" || !config.googleClientIds.includes(payload.azp))) throw invalidToken();

    const email = cleanEmail(payload.email);
    const picture = typeof payload.picture === "string" && payload.picture.length <= 2_048
      && URL.canParse(payload.picture) ? payload.picture : undefined;

    return {
      provider: "google",
      subject: cleanSubject(payload.sub),
      email,
      suggestedName: cleanText(payload.name)
        ?? cleanText([payload.given_name, payload.family_name].filter((part) => typeof part === "string").join(" ")),
      profileImageUrl: picture,
      // Google is authoritative for Gmail and verified Workspace identities, not arbitrary verified OAuth emails.
      canAutoLinkEmail: email.endsWith("@gmail.com") || (typeof payload.hd === "string" && payload.hd.length > 0),
    };
  } catch (error) {
    return mapVerificationError(error);
  }
}

const appleClientId = (platform: AppleAuthInput["platform"]) => {
  const clientId = platform === "ios" ? config.APPLE_BUNDLE_ID : config.APPLE_SERVICE_ID;
  if (!clientId) throw providerNotConfigured();
  return clientId;
};

let appleSigningKey: ReturnType<typeof importPKCS8> | undefined;

async function createAppleClientSecret(clientId: string) {
  if (!config.APPLE_TEAM_ID || !config.APPLE_KEY_ID || !config.APPLE_PRIVATE_KEY) throw providerNotConfigured();
  try {
    appleSigningKey ??= importPKCS8(config.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"), "ES256");
    const now = Math.floor(Date.now() / 1_000);
    return await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.APPLE_KEY_ID })
      .setIssuer(config.APPLE_TEAM_ID)
      .setSubject(clientId)
      .setAudience("https://appleid.apple.com")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(await appleSigningKey);
  } catch {
    throw providerNotConfigured();
  }
}

async function exchangeAppleCode(input: AppleAuthInput, clientId: string) {
  if (input.platform !== "ios" && !config.APPLE_REDIRECT_URI) throw providerNotConfigured();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: await createAppleClientSecret(clientId),
    code: input.authorizationCode,
    grant_type: "authorization_code",
  });
  if (input.platform !== "ios") body.set("redirect_uri", config.APPLE_REDIRECT_URI);

  let response: Response;
  try {
    response = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw providerUnavailable();
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) throw providerUnavailable();
    throw invalidToken();
  }

  const tokenResponse = await response.json().catch(() => undefined) as { id_token?: unknown } | undefined;
  if (typeof tokenResponse?.id_token !== "string") throw providerUnavailable();
  return tokenResponse.id_token;
}

async function verifyAppleIdToken(identityToken: string, clientId: string) {
  try {
    return (await jwtVerify(identityToken, appleKeys, {
      algorithms: ["RS256"],
      issuer: "https://appleid.apple.com",
      audience: clientId,
      requiredClaims: ["sub", "iat", "exp"],
    })).payload;
  } catch (error) {
    return mapVerificationError(error);
  }
}

const codeHashMatches = (payload: JWTPayload, code: string) => {
  if (typeof payload.c_hash !== "string") return true;
  const expected = createHash("sha256").update(code).digest().subarray(0, 16).toString("base64url");
  const actualBuffer = Buffer.from(payload.c_hash);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export async function verifyAppleAuthorization(input: AppleAuthInput): Promise<SocialIdentity> {
  const clientId = appleClientId(input.platform);
  const exchangedToken = await exchangeAppleCode(input, clientId);
  const presented = await verifyAppleIdToken(input.identityToken, clientId);
  const exchanged = exchangedToken === input.identityToken
    ? presented
    : await verifyAppleIdToken(exchangedToken, clientId);

  const subject = cleanSubject(presented.sub);
  if (subject !== cleanSubject(exchanged.sub) || !codeHashMatches(presented, input.authorizationCode)) throw invalidToken();
  if (input.nonce && presented.nonce !== input.nonce) throw invalidToken();
  if (typeof presented.nonce === "string" && typeof exchanged.nonce === "string" && presented.nonce !== exchanged.nonce) throw invalidToken();

  const presentedEmail = presented.email === undefined ? undefined : cleanEmail(presented.email);
  const exchangedEmail = exchanged.email === undefined ? undefined : cleanEmail(exchanged.email);
  if (presentedEmail && exchangedEmail && presentedEmail !== exchangedEmail) throw invalidToken();
  const email = presentedEmail ?? exchangedEmail;
  const emailVerified = email
    ? verifiedClaim(presentedEmail ? presented.email_verified : exchanged.email_verified)
    : false;
  if (email && !emailVerified) throw invalidToken();

  const requestedName = [cleanText(input.givenName), cleanText(input.familyName)].filter(Boolean).join(" ").slice(0, 80);
  return {
    provider: "apple",
    subject,
    email,
    suggestedName: requestedName || undefined,
    canAutoLinkEmail: emailVerified,
  };
}
