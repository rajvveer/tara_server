import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "./config.js";
import { ApiError } from "./errors.js";
import { prisma } from "./db.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export const issueAccessToken = (userId: string) => jwt.sign(
  { sub: userId },
  config.JWT_SECRET,
  {
    expiresIn: config.ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  },
);

export const issueSession = async (userId: string, metadata: { userAgent?: string; ipAddress?: string }) => {
  const refreshToken = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000);
  await prisma.session.create({
    data: { userId, tokenHash: hash(refreshToken), expiresAt, ...metadata },
  });
  return {
    accessToken: issueAccessToken(userId),
    refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: config.ACCESS_TOKEN_TTL,
  };
};

export const rotateSession = async (refreshToken: string, metadata: { userAgent?: string; ipAddress?: string }) => {
  const session = await prisma.session.findUnique({ where: { tokenHash: hash(refreshToken) } });
  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Your session has expired. Please sign in again.");
  }

  return prisma.$transaction(async (transaction) => {
    await transaction.session.delete({ where: { id: session.id } });
    const nextRefreshToken = randomBytes(48).toString("base64url");
    await transaction.session.create({
      data: {
        userId: session.userId,
        tokenHash: hash(nextRefreshToken),
        expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000),
        ...metadata,
      },
    });
    return {
      accessToken: issueAccessToken(session.userId),
      refreshToken: nextRefreshToken,
      tokenType: "Bearer" as const,
      expiresIn: config.ACCESS_TOKEN_TTL,
    };
  });
};

export const revokeSession = (refreshToken: string) =>
  prisma.session.deleteMany({ where: { tokenHash: hash(refreshToken) } });

export const newPasswordResetToken = () => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hash(token) };
};

export const passwordResetHash = hash;

export const verifyAccessToken = (token: string) => {
  const payload = jwt.verify(token, config.JWT_SECRET, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
  if (typeof payload === "string" || typeof payload.sub !== "string") throw new Error("Invalid subject");
  return payload.sub;
};

export const requireAuth: RequestHandler = (request, _response, next) => {
  const [scheme, token] = request.headers.authorization?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) return next(new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue."));

  try {
    request.userId = verifyAccessToken(token);
    next();
  } catch {
    next(new ApiError(401, "INVALID_ACCESS_TOKEN", "Your session is invalid or has expired."));
  }
};
