import { z } from "zod";

export const harnessIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{1,31}$/,
    "ID 应为 2–32 位小写字母、数字或连字符，以字母开头",
  );
const template = z
  .string()
  .min(1, "路径不能为空")
  .regex(
    /^(?:[^{}\x00-\x1f]|\{root\}|\{env:[A-Z_][A-Z0-9_]*\|[^{}\x00-\x1f]+\})+$/,
    "路径模板无效：只支持 ~、{root}、{env:NAME|fallback}",
  );
const relative = z
  .string()
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)(?![A-Za-z]:)(?!.*[{}~\\\x00-\x1f]).+$/,
    "项目路径必须为相对路径，不能包含 .、..、空路径段或绝对路径",
  );
const reader = z.union([
  template,
  z.strictObject({ path: template, legacy: z.boolean().optional() }),
]);
export const harnessManifestSchema = z
  .strictObject({
    $schema: z.string().optional(),
    id: harnessIdSchema,
    name: z.string().min(1).max(40),
    homepage: z.url().optional(),
    monogram: z
      .string()
      .regex(/^[^\s\p{C}]{1,2}$/u, "缩写需要 1–2 个可见字符")
      .optional(),
    root: z.strictObject({
      env: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]*$/)
        .optional(),
      default: template.regex(
        /^(?!.*\{root\}).*$/,
        "root.default 不能引用自身 {root}",
      ),
    }),
    detect: z.array(template).min(1),
    version: z
      .strictObject({
        command: z
          .string()
          .regex(
            /^[A-Za-z0-9._-]+$/,
            "版本命令只能是裸可执行名称，不能包含路径或 shell 字符",
          ),
        args: z
          .array(
            z.enum(["--version", "-v", "-V", "version"], {
              error: "只允许版本查询参数 --version、-v、-V、version",
            }),
          )
          .min(1)
          .max(1),
      })
      .optional(),
    instructions: z.strictObject({
      global: z
        .array(
          z.strictObject({
            path: template,
            kind: z.enum(["main", "override", "shared", "rules"]),
            when: z.literal("non-empty").optional(),
          }),
        )
        .min(1),
      fragments: z.array(
        template.regex(/\/\*\*\/\*\.md$/, "片段 glob 必须以 /**/*.md 结尾"),
      ),
      project: relative,
    }),
    skills: z.strictObject({
      global: template,
      project: relative,
      reads: z.strictObject({
        global: z.array(reader).min(1),
        project: z
          .array(
            z.union([
              relative,
              z.strictObject({
                path: relative,
                legacy: z.boolean().optional(),
              }),
            ]),
          )
          .min(1),
      }),
      sameNameCopies: z.enum(["collapse", "list"]),
    }),
    notes: z.strictObject({
      "zh-CN": z.string().optional(),
      en: z.string().optional(),
    }),
  })
  .superRefine((m, ctx) => {
    if (
      !m.instructions.global.some(
        (e) => ["main", "override"].includes(e.kind) && !e.when,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["instructions", "global"],
        message:
          "需要无条件 main 或 override 作为部署回退；shared/rules 只扫描",
      });
    for (const scope of ["global", "project"] as const)
      if (
        !m.skills.reads[scope].some(
          (r) => (typeof r === "string" ? r : r.path) === m.skills[scope],
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["skills", "reads", scope],
          message: "读取目录必须包含原生技能目录的相同模板",
        });
  });
export type HarnessManifest = z.infer<typeof harnessManifestSchema>;
export const harnessJSONSchema = () =>
  z.toJSONSchema(harnessManifestSchema, { unrepresentable: "any" });
