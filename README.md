# GoalSpring API

Production-minded Node.js/TypeScript API for the GoalSpring personal goals app. It uses Express 5, PostgreSQL, Prisma, Zod, rotating refresh tokens, and strict per-user query scoping.

## Run locally

Requirements: Node.js 20+ and Docker.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:deploy
npm run db:seed
npm run dev
```

If port `5432` is already occupied, run PostgreSQL on another host port and update `DATABASE_URL`:

```powershell
$env:POSTGRES_PORT = "5433"
docker compose up -d
```

The API defaults to `http://localhost:4000`. Useful URLs:

- Health: `GET /health`
- Swagger UI: `GET /api/docs`
- OpenAPI JSON: `GET /api/openapi.json`
- API base: `/api/v1`

Demo seed credentials: `demo@onward.app` / `OnwardDemo123!`

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | At least 32 random characters; never commit a real value |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Access-token boundaries |
| `ACCESS_TOKEN_TTL` | Short-lived JWT TTL, default `15m` |
| `REFRESH_TOKEN_DAYS` | Opaque rotating session lifetime, default `30` |
| `CORS_ORIGINS` | Comma-separated Flutter-web/dev origins; native Flutter requests have no browser origin |
| `GOOGLE_CLIENT_IDS` | Comma-separated OAuth client IDs accepted as Google ID-token audiences |
| `APPLE_BUNDLE_ID`, `APPLE_SERVICE_ID` | Allowed Apple audiences for native iOS and Android/web respectively |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple developer credentials used only server-side to exchange single-use authorization codes |
| `APPLE_REDIRECT_URI` | HTTPS return URL used by the Android/web Apple authorization flow |
| `APPLE_ANDROID_PACKAGE` | Fixed Android application ID used by the Apple callback intent; defaults to `com.intentional.onward` |
| `APP_URL` | Public HTTPS app URL used in password-reset links |
| `RESEND_API_KEY`, `RESET_FROM_EMAIL` | Resend credentials for production password-reset delivery |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON used to deliver queued push notifications through FCM |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Local alternative path to the Firebase service-account JSON |
| `CRON_SECRET` | Random secret used to authorize the Vercel maintenance cron endpoint |
| `SARVAM_API_KEY` | Server-only Sarvam credential for Saaras v3 STT and Bulbul v3 TTS |
| `GROQ_API_KEY` | Server-only Groq credential for GPT-OSS 120B goal extraction and conversation turns |
| `PORT`, `NODE_ENV` | HTTP port and runtime mode |

## Response contract

JSON success responses use `{ "data": ... }`. Paginated lists use:

```json
{
  "data": [],
  "meta": { "page": 1, "limit": 20, "total": 0, "pages": 0 }
}
```

Errors use `{ "error": { "code": "...", "message": "...", "details": [] }, "requestId": "..." }`. DELETE/logout operations return `204` with no body. Dates are ISO-8601 strings; enums are uppercase; all JSON fields are camelCase.

Register, login, Google auth, and Apple auth return `{data:{user,accessToken,refreshToken,tokenType,expiresIn}}`. Refresh rotates the refresh token and returns `{data:{accessToken,refreshToken,tokenType,expiresIn}}`. Store tokens in the OS secure keychain on mobile, not plain local preferences.

## Endpoint summary

All endpoints below are under `/api/v1`; everything except auth requires `Authorization: Bearer <accessToken>`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password` |
| Profile | `GET/PATCH/DELETE /users/me`, `GET /users/me/export`, `GET/PATCH /users/me/preferences`, `POST /users/me/onboarding` |
| Realtime voice onboarding | `WS /realtime` (`auth`, `voice.start`, `voice.turn`) |
| Voice HTTP fallback | `POST /voice/onboarding/start`, `POST /voice/onboarding/turn` |
| Goals | `GET/POST /goals`, `GET/PATCH/DELETE /goals/:id` |
| Milestones | `GET/POST /goals/:goalId/milestones`, `PATCH/DELETE /milestones/:id` |
| Actions | `GET/POST /actions`, `GET /actions/today`, `PATCH/DELETE /actions/:id`, `POST /actions/:id/{start,complete,skip,miss,reopen}` |
| Routines | `GET/POST /routines`, `PATCH/DELETE /routines/:id` |
| Product views | `GET /dashboard`, `GET /schedule?from=&to=` |
| Progress | `GET /progress/overview`, `/progress/goals/:goalId`, `/progress/weekly`, `/progress/monthly` |
| Reflections | `GET/POST /reflections`, `PATCH /reflections/:id` |
| Notifications | `GET /notifications`, `GET/PATCH /notifications/preferences`, `POST /notifications/devices`, `POST /notifications/devices/unregister`, `PATCH /notifications/:id/read`, `POST /notifications/read-all` |

Swagger contains the live route index and response descriptions.

## Goal status calculation

`src/goal-progress.ts` deliberately uses more than a completion percentage:

1. Completion is completed actions divided by all retained actions.
2. Expected progress is the higher of elapsed goal timeframe and chosen cadence (`frequency` + `weeklyTarget`).
3. Adherence uses only planned actions already due; future upcoming actions never hurt consistency.
4. A 10-point lead with healthy adherence is `AHEAD`. A 5-point expected-progress gap or adherence below 70% is `NEEDS_ATTENTION`; a 15-point gap or adherence below 50% is `BEHIND`.
5. A completed goal or all actions completed is `COMPLETED`; otherwise it is `ON_TRACK`.

This makes missed planned work visible even when the raw percentage still looks healthy.

## Security and data lifecycle

- Passwords use bcrypt cost 12 and are never selected into public responses.
- Google ID tokens are verified against Google's JWKS, RS256 signature, issuer, configured audience, expiry, and verified-email claim. The stable `sub`, never email, is the provider identity.
- Apple authorization codes are exchanged server-to-server, both identity tokens are verified against Apple's JWKS/issuer/configured platform audience/expiry, and subject, code hash, and supplied nonce are cross-checked.
- Provider subjects are unique in PostgreSQL. A verified Gmail or Workspace identity may link by matching email; arbitrary Google OAuth emails require an already-authenticated linking flow. Apple links only an email Apple marks verified. Existing subjects always win over changing email claims.
- Apple may omit name and email after first consent; returning users are found by the stable Apple subject. Social-only accounts have no password hash until they complete password reset.

### Sign in with Apple on Android

Register the exact HTTPS `APPLE_REDIRECT_URI` as the Apple Services ID return URL and pass the same URL to Flutter's `WebAuthenticationOptions`. It should point to `POST /api/v1/auth/apple/callback` on this server. Apple posts the authorization response there; the route accepts only bounded `code`, `id_token`, `state`, optional `user`, or error fields, then returns a `303` to this fixed intent:

```text
intent://callback?...#Intent;package=com.intentional.onward;scheme=signinwithapple;end
```

The callback only hands the response back to the installed app. The app must validate its original `state`, then send `authorizationCode`, `identityToken`, `platform`, and optional profile fields to `POST /api/v1/auth/apple`; that endpoint remains responsible for Apple code exchange and cryptographic verification.
- Access JWTs are short-lived. Refresh tokens are high-entropy, stored only as SHA-256 hashes, and rotated on every refresh.
- Password reset tokens are hashed, one-hour, single-use, and revoke all sessions after reset.
- Auth and voice routes are rate-limited; the realtime socket authenticates in its first frame, checks allowed browser origins, validates every event, and caps payloads at 1.4 MB. Helmet, allowlisted CORS, Zod validation, and request IDs remain enabled for HTTP.
- Every user-owned lookup includes `userId`. Integration tests prove a second account receives `404` and cannot mutate another user's goal/action.
- Account export uses explicit safe selections and excludes password hashes, sessions, reset tokens, and all token hashes. Account deletion hard-deletes the user and PostgreSQL cascades all owned rows.
- Goals, milestones, and actions are soft-deleted so history is preserved. Foreign keys and cascade rules protect relational integrity.

Production password resets are sent through Resend. The secure token is exposed only in non-production; production startup requires `APP_URL`, `RESEND_API_KEY`, `RESET_FROM_EMAIL`, `SARVAM_API_KEY`, and `GROQ_API_KEY`.

## Analytics and notifications

The backend records low-sensitivity lifecycle events: account/goal/milestone/action creation, goal edits/completion, action status changes, and reflection submission. Event properties contain entity IDs and broad categories/statuses, never passwords, reflection text, or auth tokens.

Notification preferences, quiet hours, scheduled notification records, unread state, reminder lead time, and device tokens live in PostgreSQL. Goal creation queues a confirmation; the maintenance worker queues before/due task reminders, an 8 PM local-time unfinished-task summary, milestone reminders, progress summaries, and weekly reflections, then sends due records through Firebase Cloud Messaging. The Node server runs it every five minutes; Vercel invokes the protected `/api/maintenance` cron route on the same schedule when `CRON_SECRET` is configured. Run only one scheduler instance when horizontally scaling.

## Tests

Fast logic tests run without PostgreSQL:

```bash
npm test
```

The API journey is automatically skipped unless a dedicated database is supplied. It covers onboarding goal/routine creation, push-device registration, recurring generation, automatic missed actions, the complete action lifecycle, progress history, social auth, and cross-user isolation:

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/set_a_goal_test?schema=public"
npm test
```

Use a disposable test database. The suite deletes only the two uniquely named users it creates.

Quality commands:

```bash
npm run typecheck
npm run build
npm audit
```

With funded Sarvam and Groq keys, the live smoke check synthesizes a Hindi answer, auto-detects/transcribes it with Sarvam, extracts a complete goal draft with GPT-OSS 120B, and speaks the Hindi reply with Sarvam. It uses real provider credits:

```bash
npx tsx scripts/voice-smoke.ts
```

## Deploy

For Railway, Render, Fly.io, or a container platform:

1. Provision PostgreSQL and set `DATABASE_URL`, a new `JWT_SECRET`, production `CORS_ORIGINS`, and `NODE_ENV=production`.
2. Build with `npm ci && npm run build`.
3. Run `npm run db:deploy` as a release/pre-deploy command.
4. Start with `npm start` and health-check `/health`.
5. Optionally run `npm run db:seed` only for demo environments.

Never use `prisma db push` in production; the committed migration is the deployment source of truth.
