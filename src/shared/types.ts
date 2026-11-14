import { z } from "zod";

import { harnessIdSchema } from "./harness-manifest.ts";
import { harnessIds } from "./harnesses.ts";
export { harnessIds, harnessNames } from "./harnesses.ts";
export type HarnessId = string;
export const scopeSchema = z
  .object({
    kind: z.enum(["global", "device", "project"]).default("global"),
    target: z.string().optional(),
    harnesses: z
      .array(harnessIdSchema)
      .min(1)
      .default([...harnessIds]),
  })
  .refine(
    (s) => s.kind === "global" || Boolean(s.target),
    "设备或项目作用域需要 target",
  );
export type Scope = z.infer<typeof scopeSchema>;
export const ruleInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(128_000),
  enabled: z.boolean().default(true),
  scope: scopeSchema.default({ kind: "global", harnesses: [...harnessIds] }),
});
export type Rule = z.infer<typeof ruleInput> & { id: string };
export const skillInput = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().trim().min(1).max(2000),
  displayName: z.string().trim().min(1).max(100).optional(),
  body: z.string().max(256_000),
  enabled: z.boolean().default(true),
  scope: scopeSchema.default({ kind: "global", harnesses: [...harnessIds] }),
});
export const gitSkillSourceSchema = z.object({
  type: z.literal("git"),
  url: z.string().min(1),
  ref: z.string().min(1),
  subpath: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  installedHash: z.string().min(1),
  tree: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
});
export type GitSkillSource = z.infer<typeof gitSkillSourceSchema>;
export type Skill = Omit<z.infer<typeof skillInput>, "body"> & {
  id: string;
  source?: string | GitSkillSource;
};
export const projectInput = z.object({
  name: z.string().trim().min(1).max(100),
  path: z.string().optional(),
});
export type Project = { id: string; name: string };
export type Manifest = {
  schemaVersion: 1;
  rules: Rule[];
  skills: Skill[];
  projects: Project[];
};
export type Device = {
  ruleOrder?: string[];
  disabledHarnesses?: string[];
  id: string;
  name: string;
  home: string;
  variables: Record<string, string>;
  bindings: Record<string, string>;
  origins?: Record<string, string>;
  originRealPaths?: Record<string, string>;
  // Source directory fingerprint when it was last read into the library.
  originHashes?: Record<string, string>;
  ignoredNativePaths?: string[];
};
export type Harness = {
  source: "builtin" | "user";
  enabled: boolean;
  monogram?: string;
  homepage?: string;
  notes: { "zh-CN"?: string; en?: string };
  id: HarnessId;
  name: string;
  version: string | null;
  installed: boolean;
  home: string;
  instructions: string;
  skills: string;
  sharedSkills: string[];
  instructionSources: {
    path: string;
    kind: "main" | "override" | "shared" | "rules";
    active: boolean;
  }[];
  note: string;
};
export type Receipt = {
  fullNativeHash?: string;
  globalPaths?: { home: string; skills: string; instructions: string };
  instructionCreated?: boolean;
  adoptedSourceHash?: string;
  adoptedLink?: string;
  kind: "instructions" | "skill";
  harness: HarnessId;
  path: string;
  hash: string;
  sourceId?: string;
  projectId?: string;
};
export type DeployState = {
  onboarding?: { id: string; startedAt: string; expiresAt: string };
  lastFullApplyAt?: string;
  receipts: Receipt[];
  instructionConsents?: { path: string; outsideHash: string }[];
  conflictChoices?: Record<
    string,
    {
      use: "library" | "native" | "skip";
      fingerprint: string;
      sourceId: string;
      sourceHash?: string;
      adoptScope?: string;
    }
  >;
  instructionReplacements?: { path: string; hash: string }[];
};
export type Change = {
  path: string;
  kind: Receipt["kind"];
  harness: HarnessId;
  sourceId?: string;
  projectId?: string;
  status:
    | "replace"
    | "skipped"
    | "adopt"
    | "create"
    | "update"
    | "remove"
    | "unchanged"
    | "conflict";
  reason: string;
  beforeHash: string;
  afterHash: string;
  before: string;
  after: string;
  diff: string;
  conflictFingerprint?: string;
  conflictOptions?: string[];
  fileChanges?: {
    path: string;
    status: "added" | "removed" | "modified";
    binary: boolean;
    beforeLink?: string;
    beforeSize: number;
    afterSize: number;
    beforeHash: string;
    afterHash: string;
    diff?: string;
  }[];
  files?: Record<string, { content: string; mode: number }>;
};
export type PlanNotice = {
  code:
    | "harness-root-changed"
    | "plugin-manifest-error"
    | "unknown-harness"
    | "retained-harness-paths"
    | "shared-skill-exposure"
    | "staging-leftover"
    | "ignored-native-path"
    | "skill-source-changed"
    | "skill-source-unreadable"
    | "skill-missing-variable";
  message: string;
  blocking: boolean;
  path?: string;
};
export type Plan = {
  id: string;
  revision: string;
  changes: Change[];
  errors: string[];
  warnings?: string[];
  notices: PlanNotice[];
  createdAt: string;
};
export type Snapshot = {
  onboarding?: DeployState["onboarding"] | null;
  notices?: import("../core/notices.ts").Notice[];
  autoDeploy?: import("../core/auto-deploy.ts").AutoDeployResult | null;
  revision: string;
  manifest: Manifest;
  device: Device;
  harnesses: Harness[];
  plan: Plan;
  history: { hash: string; date: string; message: string }[];
  deployments: {
    id: string;
    date: string;
    changes: number;
    rolledBack: boolean;
    status: "pending" | "applied" | "failed" | "rolled-back";
  }[];
  root: string;
  sync?: {
    ignore?: SyncIgnoreStatus;
    connected: boolean;
    remote?: string;
    lastSyncTime?: string;
    conflicts: number;
  };
};
export type DiscoveredSkill = {
  key: string;
  path: string;
  name: string;
  description: string;
  harnesses: HarnessId[];
  valid: boolean;
  error?: string;
  managed: boolean;
  paths: string[];
  hash?: string;
  projectIds: string[];
  linked: boolean;
  entryFile?: string;
  origin: "user" | "platform" | "tool-managed" | "system" | "bundled";
  bundledBy?: { name: string; path: string };
  credentials: string[];
  originReason: string;
  sourceUrl?: string;
  ignored: boolean;
  library?: {
    status: "same" | "differs" | "absent";
    id?: string;
    name?: string;
  };
};
export type Inspection = {
  skills: DiscoveredSkill[];
  instructions: {
    harness: HarnessId;
    path: string;
    exists: boolean;
    body: string;
    key: string;
    harnesses: HarnessId[];
    kind: "main" | "override" | "shared" | "rules";
    active: boolean;
    hash?: string;
    error?: string;
    managed: boolean;
  }[];
  roots: {
    path: string;
    harnesses: HarnessId[];
    exists: boolean;
    error?: string;
  }[];
  warnings: string[];
  duplicates: {
    name: string;
    keys: string[];
    variants: number;
    unverified: number;
  }[];
  summary: {
    bundledSkills: number;
    credentialSkills: number;
    importableSkills: number;
    excludedSkills: number;
    ignoredSkills: number;
    physicalSkills: number;
    names: number;
    validSkills: number;
    instructionFiles: number;
    instructionVariants: number;
    nameConflicts: number;
    library?: { same: number; differs: number; absent: number };
  };
};

export type Onboarding = {
  backupDir?: string;
  id: string;
  createdAt: string;
  inventory: Inspection;
  inventoryPath: string;
  prompt: string;
  promptPath: string;
  bootstrap?: {
    deploymentId: string | null;
    targets: HarnessId[];
    changes: number;
  };
};

export type SyncConflict = {
  entryId: string;
  kind: "rules" | "skills" | "projects";
  localCommit: string;
  remoteCommit: string;
  reason: "entry" | "name";
  localId?: string;
};
export type SyncConfig = {
  url: string;
  branch: string;
  lastFetchedCommit?: string;
  lastSyncedCommit?: string;
  lastSyncTime?: string;
  conflicts: SyncConflict[];
};
export type AutoSyncSettings = {
  enabled: boolean;
  debounceSeconds: number;
  pullIntervalMinutes: number;
};
export type SyncRuntime = {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextRunAt?: string;
  pullDueAt?: string;
  failures: number;
  pendingDeployment: number;
  pendingPush?: boolean;
  observedSource?: string;
  changedAt?: string;
};
export type SyncIgnoreStatus = {
  rules: string[];
  matched: { skill: string; files: string[] | "all" }[];
};
export type SyncStatus = {
  ignore?: SyncIgnoreStatus;
  ignoreCount?: number;
  autoDeploy?: import("../core/auto-deploy.ts").AutoDeployResult | null;
  auto: AutoSyncSettings;
  scheduler: SyncRuntime;
  remoteRepositoryRetained: true;
  connected: boolean;
  remote?: string;
  branch?: string;
  ahead: number;
  behind: number;
  lastFetchedCommit?: string;
  lastSyncedCommit?: string;
  lastSyncTime?: string;
  conflicts: SyncConflict[];
  pushBlocked?: boolean;
  message: string;
  undo?: {
    available: boolean;
    kind?: "resolve" | "restore" | "recovery";
    at?: string;
  };
};
export type SyncSetup = {
  url?: string;
  create?: string | boolean;
  branch?: string;
};
export type SyncResolve = {
  entryId: string;
  keep: "local" | "remote" | "both";
};
