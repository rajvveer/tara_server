import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError, type ZodTypeAny } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const validate = (schema: ZodTypeAny, source: "body" | "query" | "params" = "body"): RequestHandler =>
  (request, _response, next) => {
    const parsed = schema.safeParse(request[source]);
    if (!parsed.success) return next(parsed.error);
    if (source === "query") Object.defineProperty(request, "query", { value: parsed.data, configurable: true });
    else request[source] = parsed.data;
    next();
  };

export const notFound: RequestHandler = (_request, _response, next) =>
  next(new ApiError(404, "NOT_FOUND", "The requested resource was not found."));

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const bodyError = error as { type?: string; status?: number };
  if (bodyError.type === "entity.too.large" || bodyError.type === "parameters.too.many") {
    response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." }, requestId: request.id });
    return;
  }
  if (bodyError.type === "entity.parse.failed") {
    response.status(400).json({ error: { code: "INVALID_REQUEST_BODY", message: "The request body could not be parsed." }, requestId: request.id });
    return;
  }

  if (error instanceof ZodError) {
    response.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Please check the submitted values.",
        details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      },
      requestId: request.id,
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    response.status(409).json({
      error: { code: "CONFLICT", message: "A record with those values already exists." },
      requestId: request.id,
    });
    return;
  }

  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");

  if (apiError.status >= 500) {
    console.error(JSON.stringify({ level: "error", requestId: request.id, message: error instanceof Error ? error.message : String(error) }));
  }

  response.status(apiError.status).json({
    error: { code: apiError.code, message: apiError.message, ...(apiError.details === undefined ? {} : { details: apiError.details }) },
    requestId: request.id,
  });
};
