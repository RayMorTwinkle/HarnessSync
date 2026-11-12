import { z } from "zod";

import { harnessIds } from "./harnesses.ts";
export { harnessIds, harnessNames } from "./harnesses.ts";
export type HarnessId = (typeof harnessIds)[number];
export const scopeSchema = z
  .object({
    kind: z.enum(["global", "device", "project"]).default("global"),
    target: z.string().optional(),
    harnesses: z
      .array(z.enum(harnessIds))
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
export type Skill = Omit<z.infer<typeof skillInput>, "body"> & {
  id: string;
  source?: string;
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
  id: string;
  name: string;
  home: string;
  variables: Record<string, string>;
  bindings: Record<string, string>;
  origins?: Record<string, string>;
};
export type Harness = {
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
  kind: "instructions" | "skill";
  harness: HarnessId;
  path: string;
  hash: string;
  sourceId?: string;
  projectId?: string;
};
export type DeployState = {
  receipts: Receipt[];
  instructionReplacements?: { path: string; hash: string }[];
};
export type Change = {
  path: string;
  kind: Receipt["kind"];
  harness: HarnessId;
  sourceId?: string;
  projectId?: string;
  status: "adopt" | "create" | "update" | "remove" | "unchanged" | "conflict";
  reason: string;
  beforeHash: string;
  afterHash: string;
  before: string;
  after: string;
  diff: string;
  files?: Record<string, { content: string; mode: number }>;
};
export type Plan = {
  id: string;
  revision: string;
  changes: Change[];
  errors: string[];
  warnings?: string[];
  createdAt: string;
};
export type Snapshot = {
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
    physicalSkills: number;
    names: number;
    validSkills: number;
    instructionFiles: number;
    instructionVariants: number;
    nameConflicts: number;
  };
};

export type Onboarding = {
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
  lastSyncedCommit?: string;
  lastSyncTime?: string;
  conflicts: SyncConflict[];
};
export type SyncStatus = {
  connected: boolean;
  remote?: string;
  branch?: string;
  ahead: number;
  behind: number;
  lastSyncedCommit?: string;
  lastSyncTime?: string;
  conflicts: SyncConflict[];
  pushBlocked?: boolean;
  message: string;
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
