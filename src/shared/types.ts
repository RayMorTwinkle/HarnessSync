import { z } from "zod";

export const harnessIds = ["deepseek", "opencode"] as const;
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
export type DeployState = { receipts: Receipt[] };
export type Change = {
  path: string;
  kind: Receipt["kind"];
  harness: HarnessId;
  sourceId?: string;
  projectId?: string;
  status: "create" | "update" | "remove" | "unchanged" | "conflict";
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
};
export type Inspection = {
  skills: DiscoveredSkill[];
  instructions: {
    harness: HarnessId;
    path: string;
    exists: boolean;
    body: string;
  }[];
};
