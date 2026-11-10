import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["operator", "member"]);
export const userStatusEnum = pgEnum("user_status", ["active", "suspended"]);

export const appStatusEnum = pgEnum("app_status", [
  "building",
  "running",
  "stopped",
  "suspended",
  "expired",
  "deleted",
]);
export const appVisibilityEnum = pgEnum("app_visibility", ["allowlist", "instance"]);

export const releaseStatusEnum = pgEnum("release_status", ["building", "ready", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull().default(""),
  githubId: text("github_id"),
  handle: text("handle").notNull().unique(),
  role: userRoleEnum("role").notNull().default("member"),
  status: userStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    status: appStatusEnum("status").notNull().default("stopped"),
    visibility: appVisibilityEnum("visibility").notNull().default("allowlist"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    pinned: boolean("pinned").notNull().default(false),
    /** When the 7-day expiry warning went out for the current `expires_at` (T2.5). */
    expiryWarnedAt: timestamp("expiry_warned_at", { withTimezone: true }),
  },
  (t) => [unique("apps_owner_slug").on(t.ownerId, t.slug)],
);

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer("version").notNull(),
    imageRef: text("image_ref").notNull().default(""),
    manifest: jsonb("manifest").notNull().default(sql`'{}'::jsonb`),
    status: releaseStatusEnum("status").notNull().default("building"),
    buildLogRef: text("build_log_ref"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("releases_app_version").on(t.appId, t.version)],
);

export const machines = pgTable("machines", {
  appId: uuid("app_id")
    .primaryKey()
    .references(() => apps.id),
  providerId: text("provider_id").notNull().default(""),
  volumeRef: text("volume_ref").notNull().default(""),
  state: text("state").notNull().default("missing"),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastRequestAt: timestamp("last_request_at", { withTimezone: true }),
  /** Seconds spent running before the current run (T2.7); see machines/running-time.ts. */
  runningSeconds: bigint("running_seconds", { mode: "number" }).notNull().default(0),
  /** Last measured /data size and when (T2.7; written by the quota sweep). */
  volumeBytes: bigint("volume_bytes", { mode: "number" }),
  volumeMeasuredAt: timestamp("volume_measured_at", { withTimezone: true }),
});

export const pats = pgTable("pats", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  name: text("name").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => users.id),
  appId: uuid("app_id").references(() => apps.id),
  action: text("action").notNull(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  /** Host that issued the cookie — sessions are host-bound (INV4). */
  appHost: text("app_host").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** One-time gateway login codes (AGENTS §9 step 3–4). Stored hashed. */
export const loginCodes = pgTable("login_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  appHost: text("app_host").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/** OAuth CSRF state + PKCE verifier (auth host). */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Email magic links (T1.1). Single-use, 10-minute TTL, stored hashed (INV5).
 * Bound to the app host the user was trying to reach (`app_host`).
 */
export const magicLinks = pgTable("magic_links", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  appHost: text("app_host").notNull(),
  returnTo: text("return_to").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/**
 * Per-app allowlist (T1.2). Keyed by lowercase email so an app can be shared
 * before the person has an account; their first sign-in with that email links.
 */
export const appAccess = pgTable(
  "app_access",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    email: text("email").notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.email] })],
);

/** Postgres bytea as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Per-app env vars (T1.6). Every value is envelope-encrypted with MASTER_KEY
 * (see src/secrets/crypto.ts); `is_secret` values are write-only via the API.
 */
export const envVars = pgTable(
  "env_vars",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    key: text("key").notNull(),
    valueCiphertext: bytea("value_ciphertext").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.key] })],
);

/**
 * Runtime stdout/stderr lines collected from app containers (T1.7b). The
 * control plane owns this store so retention is a real delete: a daily job
 * removes rows older than 7 days (AGENTS §14). Secret env values are redacted
 * before insert (INV12). Rows go away with their app.
 */
export const runtimeLogs = pgTable(
  "runtime_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    line: text("line").notNull(),
  },
  (t) => [
    index("runtime_logs_app_id_id_idx").on(t.appId, t.id),
    index("runtime_logs_app_provider_idx").on(t.appId, t.providerId),
    index("runtime_logs_at_idx").on(t.at),
  ],
);

/**
 * Raw per-viewer counters (T2.5). Each gateway touch adds one request for
 * that viewer and day (UTC); the hourly roll-up folds these into usage_daily.
 */
export const usageViewers = pgTable(
  "usage_viewers",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.appId, t.day, t.userId] })],
);

/** AGENTS §7 usage_daily: per app and UTC day. Written by the hourly roll-up (T2.5). */
export const usageDaily = pgTable(
  "usage_daily",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    requests: integer("requests").notNull().default(0),
    uniqueViewers: integer("unique_viewers").notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.appId, t.day] })],
);

/**
 * Operator-managed sign-up invites (T2.6). Only OPERATOR_EMAILS, emails some
 * app was shared to, and emails on this list may create an account.
 */
export const invites = pgTable("invites", {
  email: text("email").primaryKey(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
