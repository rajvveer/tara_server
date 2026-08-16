export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "GoalSpring API",
    version: "1.0.0",
    description: "REST API for personalized goals, routines, actions, progress, reflections, and reminders. Successful JSON responses use a `data` envelope; paginated lists add `meta`.",
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "Auth" }, { name: "Profile" }, { name: "Goals" }, { name: "Milestones" },
    { name: "Actions" }, { name: "Routines" }, { name: "Progress" }, { name: "Reflections" },
    { name: "Notifications" }, { name: "Dashboard" }, { name: "Voice" },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] }, requestId: { type: "string", format: "uuid" } },
        required: ["error", "requestId"],
      },
      Auth: {
        type: "object",
        properties: { user: { type: "object" }, accessToken: { type: "string" }, refreshToken: { type: "string" }, tokenType: { const: "Bearer" }, expiresIn: { type: "string", example: "15m" } },
        required: ["user", "accessToken", "refreshToken", "tokenType", "expiresIn"],
      },
      GoogleAuthRequest: {
        type: "object",
        additionalProperties: false,
        properties: { idToken: { type: "string" }, timezone: { type: "string", default: "UTC" } },
        required: ["idToken"],
      },
      AppleAuthRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          authorizationCode: { type: "string" },
          identityToken: { type: "string" },
          givenName: { type: "string" },
          familyName: { type: "string" },
          timezone: { type: "string", default: "UTC" },
          platform: { type: "string", enum: ["ios", "android", "web"] },
          nonce: { type: "string", description: "Optional exact nonce claim expected in the Apple identity token." },
        },
        required: ["authorizationCode", "identityToken", "platform"],
      },
      AppleCallback: {
        oneOf: [
          { type: "object", additionalProperties: false, properties: { code: { type: "string", maxLength: 4096 }, id_token: { type: "string", maxLength: 16384 }, state: { type: "string", maxLength: 2048 }, user: { type: "string", maxLength: 8192 } }, required: ["code", "id_token", "state"] },
          { type: "object", additionalProperties: false, properties: { error: { type: "string", maxLength: 128 }, error_description: { type: "string", maxLength: 1024 }, state: { type: "string", maxLength: 2048 } }, required: ["error", "state"] },
        ],
      },
      Goal: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, description: { type: ["string", "null"] }, whyItMatters: { type: ["string", "null"] }, category: { type: "string" }, priority: { type: "string" }, status: { type: "string" }, startDate: { type: "string", format: "date-time" }, targetDate: { type: ["string", "null"], format: "date-time" }, weeklyTarget: { type: "integer" }, metricUnit: { type: ["string", "null"] }, metricTarget: { type: ["number", "null"] }, metricCurrent: { type: "number" }, remindersEnabled: { type: "boolean" } },
      },
      Action: {
        type: "object",
        properties: { id: { type: "string" }, goalId: { type: "string" }, milestoneId: { type: ["string", "null"] }, title: { type: "string" }, status: { type: "string" }, scheduledFor: { type: ["string", "null"], format: "date-time" }, dueDate: { type: ["string", "null"], format: "date-time" }, estimatedMinutes: { type: ["integer", "null"] }, reminderEnabled: { type: "boolean" } },
      },
      ProgressRecord: {
        type: "object",
        properties: { id: { type: "string" }, goalId: { type: "string" }, actionId: { type: ["string", "null"] }, status: { type: "string" }, occurredAt: { type: "string", format: "date-time" }, action: { type: ["object", "null"] }, goal: { type: "object" } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/auth/register": { post: { security: [], tags: ["Auth"], summary: "Create account", responses: { "201": { description: "Created; `{data:{user,accessToken,refreshToken,...}}`" }, "422": { description: "Validation error" } } } },
    "/auth/login": { post: { security: [], tags: ["Auth"], summary: "Sign in", responses: { "200": { description: "`{data:{user,accessToken,refreshToken,...}}`" }, "401": { description: "Invalid credentials" } } } },
    "/auth/google": { post: { security: [], tags: ["Auth"], summary: "Create an account or sign in with Google", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GoogleAuthRequest" } } } }, responses: { "200": { description: "Verified provider sign-in using the standard auth response" }, "401": { description: "Invalid, expired, or unverified provider token" }, "409": { description: "Existing account requires authenticated linking or has another Google identity" }, "503": { description: "Provider unavailable or server credentials missing" } } } },
    "/auth/apple": { post: { security: [], tags: ["Auth"], summary: "Create an account or sign in with Apple", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AppleAuthRequest" } } } }, responses: { "200": { description: "Verified code and identity-token sign-in using the standard auth response" }, "401": { description: "Invalid, expired, mismatched, or unverified provider response" }, "409": { description: "Existing account is already linked to another Apple identity" }, "503": { description: "Apple unavailable or server credentials missing" } } } },
    "/auth/apple/callback": { post: { security: [], tags: ["Auth"], summary: "Return Apple's Android form_post response to the app", description: "Accepts only Apple's allowlisted form fields and redirects with 303 to the fixed `signinwithapple://callback` Android intent for the configured package. It does not authenticate; `/auth/apple` still exchanges and verifies the credentials.", requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/AppleCallback" } } } }, responses: { "303": { description: "Redirect to the configured Android application intent" }, "413": { description: "Form exceeds the parser or field limits" }, "415": { description: "Content type must be form encoded" }, "422": { description: "Unknown, missing, or invalid callback fields" } } } },
    "/auth/refresh": { post: { security: [], tags: ["Auth"], summary: "Rotate refresh token", responses: { "200": { description: "Fresh access and refresh tokens" } } } },
    "/auth/logout": { post: { security: [], tags: ["Auth"], summary: "Revoke a refresh token", responses: { "204": { description: "Revoked" } } } },
    "/auth/forgot-password": { post: { security: [], tags: ["Auth"], summary: "Request password reset", responses: { "200": { description: "Accepted whether or not account exists" } } } },
    "/auth/reset-password": { post: { security: [], tags: ["Auth"], summary: "Reset password", responses: { "200": { description: "Password changed and sessions revoked" } } } },
    "/users/me": { get: { tags: ["Profile"], summary: "Get profile", responses: { "200": { description: "Profile" } } }, patch: { tags: ["Profile"], summary: "Update profile", responses: { "200": { description: "Updated profile" } } }, delete: { tags: ["Profile"], summary: "Permanently delete account and owned data", responses: { "204": { description: "Deleted" } } } },
    "/users/me/preferences": { get: { tags: ["Profile"], summary: "Get preferences", responses: { "200": { description: "Preferences" } } }, patch: { tags: ["Profile"], summary: "Update preferences", responses: { "200": { description: "Updated" } } } },
    "/users/me/export": { get: { tags: ["Profile"], summary: "Export all account data", description: "Returns profile, settings, goals and full history without credentials, sessions, or token hashes.", responses: { "200": { description: "Safe JSON account bundle" } } } },
    "/users/me/onboarding": { post: { tags: ["Profile"], summary: "Complete onboarding", responses: { "200": { description: "User and preferences" } } } },
    "/voice/onboarding/start": { post: { tags: ["Voice"], summary: "Speak the opening onboarding question", responses: { "200": { description: "Localized prompt and base64 WAV audio" }, "503": { description: "Voice provider is not configured" } } } },
    "/voice/onboarding/turn": { post: { tags: ["Voice"], summary: "Transcribe one answer, update the proposed goal, and speak the next question", description: "Audio is processed for this response and is not persisted by GoalSpring.", responses: { "200": { description: "Transcript, same-language reply/audio, proposed answers, and completion state" }, "413": { description: "Audio payload is too large" }, "422": { description: "Invalid or unsupported audio" }, "502": { description: "Voice provider unavailable" } } } },
    "/goals": { get: { tags: ["Goals"], summary: "List goals", responses: { "200": { description: "Paginated goals with calculated progress" } } }, post: { tags: ["Goals"], summary: "Create goal", responses: { "201": { description: "Created goal" } } } },
    "/goals/{id}": { get: { tags: ["Goals"], summary: "Get full goal detail", parameters: [{ $ref: "#/components/parameters/id" }], responses: { "200": { description: "Goal with milestones, actions, routines, and history" } } }, patch: { tags: ["Goals"], summary: "Update, pause, resume, or complete goal", parameters: [{ $ref: "#/components/parameters/id" }], responses: { "200": { description: "Updated" } } }, delete: { tags: ["Goals"], summary: "Archive goal", parameters: [{ $ref: "#/components/parameters/id" }], responses: { "204": { description: "Archived" } } } },
    "/goals/{goalId}/progress": { post: { tags: ["Progress"], summary: "Log numeric progress for a goal", responses: { "201": { description: "Metric total and progress history updated" } } } },
    "/goals/{goalId}/milestones": { get: { tags: ["Milestones"], summary: "List goal milestones", responses: { "200": { description: "Milestones" } } }, post: { tags: ["Milestones"], summary: "Create milestone", responses: { "201": { description: "Created" } } } },
    "/milestones/{id}": { patch: { tags: ["Milestones"], summary: "Update milestone", responses: { "200": { description: "Updated" } } }, delete: { tags: ["Milestones"], summary: "Remove milestone", responses: { "204": { description: "Removed" } } } },
    "/actions": { get: { tags: ["Actions"], summary: "List/filter actions", responses: { "200": { description: "Paginated actions" } } }, post: { tags: ["Actions"], summary: "Create action", responses: { "201": { description: "Created" } } } },
    "/actions/today": { get: { tags: ["Actions"], summary: "Today's actions in user timezone", responses: { "200": { description: "Today's actions" } } } },
    "/actions/{id}": { patch: { tags: ["Actions"], summary: "Update action", responses: { "200": { description: "Updated" } } }, delete: { tags: ["Actions"], summary: "Remove action", responses: { "204": { description: "Removed" } } } },
    "/actions/{id}/complete": { post: { tags: ["Actions"], summary: "Complete action", responses: { "200": { description: "Completed" } } } },
    "/actions/{id}/skip": { post: { tags: ["Actions"], summary: "Skip action", responses: { "200": { description: "Skipped" } } } },
    "/actions/{id}/start": { post: { tags: ["Actions"], summary: "Start action", responses: { "200": { description: "Started" } } } },
    "/actions/{id}/reopen": { post: { tags: ["Actions"], summary: "Reopen action", responses: { "200": { description: "Reopened" } } } },
    "/actions/{id}/miss": { post: { tags: ["Actions"], summary: "Mark action missed", responses: { "200": { description: "Marked missed" } } } },
    "/routines": { get: { tags: ["Routines"], summary: "List routines", responses: { "200": { description: "Routines" } } }, post: { tags: ["Routines"], summary: "Create routine", responses: { "201": { description: "Created" } } } },
    "/routines/{id}": { patch: { tags: ["Routines"], summary: "Update routine", responses: { "200": { description: "Updated" } } }, delete: { tags: ["Routines"], summary: "Delete routine", responses: { "204": { description: "Deleted" } } } },
    "/dashboard": { get: { tags: ["Dashboard"], summary: "Personalized home dashboard", responses: { "200": { description: "Today focus, goals, milestones, and recent completions" } } } },
    "/schedule": { get: { tags: ["Dashboard"], summary: "Calendar range", responses: { "200": { description: "Actions and milestones in date range" } } } },
    "/progress/overview": { get: { tags: ["Progress"], summary: "Active-goal and weekly overview", responses: { "200": { description: "Overview" } } } },
    "/progress/goals/{goalId}": { get: { tags: ["Progress"], summary: "Goal status and history", responses: { "200": { description: "Progress" } } } },
    "/progress/history": { get: { tags: ["Progress"], summary: "Immutable progress events across goals", responses: { "200": { description: "Completion, missed, skipped, and status history" } } } },
    "/progress/weekly": { get: { tags: ["Progress"], summary: "Weekly summary", responses: { "200": { description: "Weekly summary" } } } },
    "/progress/monthly": { get: { tags: ["Progress"], summary: "Monthly summary", responses: { "200": { description: "Monthly summary" } } } },
    "/reflections": { get: { tags: ["Reflections"], summary: "List reflections", responses: { "200": { description: "Paginated reflections" } } }, post: { tags: ["Reflections"], summary: "Create weekly reflection", responses: { "201": { description: "Created" } } } },
    "/reflections/{id}": { patch: { tags: ["Reflections"], summary: "Update reflection", responses: { "200": { description: "Updated" } } } },
    "/notifications": { get: { tags: ["Notifications"], summary: "List notifications", responses: { "200": { description: "Paginated notifications and unread count" } } } },
    "/notifications/preferences": { get: { tags: ["Notifications"], summary: "Get reminder preferences", responses: { "200": { description: "Preferences" } } }, patch: { tags: ["Notifications"], summary: "Update reminder preferences", responses: { "200": { description: "Updated" } } } },
    "/notifications/devices": { post: { tags: ["Notifications"], summary: "Register or refresh a push device token", responses: { "201": { description: "Registered device" } } } },
    "/notifications/devices/unregister": { post: { tags: ["Notifications"], summary: "Disable a push device token", responses: { "204": { description: "Disabled" } } } },
    "/notifications/{id}/read": { patch: { tags: ["Notifications"], summary: "Mark read", responses: { "200": { description: "Updated" } } } },
    "/notifications/read-all": { post: { tags: ["Notifications"], summary: "Mark all read", responses: { "200": { description: "Updated count" } } } },
  },
} as const;

// Shared path parameter kept outside the long paths literal for readable docs.
(openapi.components as Record<string, unknown>).parameters = {
  id: { name: "id", in: "path", required: true, schema: { type: "string" } },
  goalId: { name: "goalId", in: "path", required: true, schema: { type: "string" } },
};

for (const [path, parameter] of Object.entries({
  "/goals/{id}": "id",
  "/goals/{goalId}/milestones": "goalId",
  "/progress/goals/{goalId}": "goalId",
  "/milestones/{id}": "id",
  "/actions/{id}": "id",
  "/actions/{id}/complete": "id",
  "/actions/{id}/skip": "id",
  "/actions/{id}/start": "id",
  "/actions/{id}/reopen": "id",
  "/actions/{id}/miss": "id",
  "/routines/{id}": "id",
  "/reflections/{id}": "id",
  "/notifications/{id}/read": "id",
})) {
  const operations =
    (openapi.paths as Record<string, Record<string, Record<string, unknown>>>)[
      path
    ] ?? {};
  for (const operation of Object.values(operations)) {
    // Keep path parameters inline so validators and generated clients can
    // inspect each operation without first resolving a component reference.
    operation.parameters = [
      {
        name: parameter,
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ];
  }
}
