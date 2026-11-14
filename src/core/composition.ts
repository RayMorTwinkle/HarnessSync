import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";
import { adapters, projectTargets } from "./adapters.ts";
import { isCredentialPath } from "./credentials.ts";
import { AppError, exists, hash, noSymlink } from "./files.ts";
import {
  instructionSegments,
  managedBlock,
  matchesScope,
  partsText,
  renderParts,
  segmentsText,
  textSegment,
} from "./rendering.ts";

export type SegmentKind =
  "native" | "shared" | "harness" | "device" | "project" | "frame";
export type Part = { type: "text" | "variable"; text: string; key?: string };
export type Segment = {
  kind: SegmentKind;
  ruleId?: string;
  title?: string;
  harnesses?: string[];
  scope?: { kind: "global" | "device" | "project"; target?: string };
  bytes: number;
  parts: Part[];
};
export type Totals = Record<SegmentKind | "variable", number>;
export type InstructionComposition = {
  path: string;
  harnesses: string[];
  projectId?: string;
  exists: boolean;
  pending: boolean;
  bytes: number;
  totals: Totals;
  segments: Segment[];
  error?: string;
};
export type SkillFileKind =
  "instructions" | "script" | "reference" | "asset" | "credential" | "other";
export type SkillComposition = {
  id: string;
  name: string;
  bytes: number;
  totals: Record<SkillFileKind | "variable", number>;
  files: {
    path: string;
    bytes: number;
    kind: SkillFileKind;
    executable: boolean;
    variables: string[];
    syncIgnored: boolean;
  }[];
};

function instructionTargets(store: Store) {
  const targets = new Map<
    string,
    { path: string; harnesses: string[]; projectId?: string }
  >();
  const add = (file: string, harness: string, projectId?: string) => {
    const absolute = path.resolve(file);
    const previous = targets.get(absolute);
    targets.set(absolute, {
      path: absolute,
      ...(projectId ? { projectId } : {}),
      harnesses: [...new Set([...(previous?.harnesses || []), harness])],
    });
  };
  for (const harness of adapters(
    store.home,
    store.root,
    store.device().disabledHarnesses,
  ).filter((h) => h.enabled)) {
    add(harness.instructions, harness.id);
    for (const project of store.manifest().projects) {
      const dir = store.device().bindings[project.id];
      if (dir)
        add(
          projectTargets(harness.id, dir, store.home, store.root).instructions,
          harness.id,
          project.id,
        );
    }
  }
  return [...targets.values()];
}

function composeInstruction(
  store: Store,
  target: ReturnType<typeof instructionTargets>[number],
): InstructionComposition {
  const errors: string[] = [];
  const totals: Totals = {
    native: 0,
    shared: 0,
    harness: 0,
    device: 0,
    project: 0,
    frame: 0,
    variable: 0,
  };
  let before = "";
  let present = false;
  let readable = false;
  try {
    present = exists(target.path);
    noSymlink(target.path);
    if (isCredentialPath(target.path))
      throw new AppError("CREDENTIAL_PATH", "组成查询不读取凭证文件内容");
    before = present ? fs.readFileSync(target.path, "utf8") : "";
    readable = true;
  } catch (e: any) {
    errors.push(e.message);
  }
  const manifest = store.manifest();
  let generated: Segment[] = [];
  const blocks = target.harnesses.map((harness) => {
    const rules = manifest.rules.filter(
      (r) =>
        r.enabled && matchesScope(store, r.scope, harness, target.projectId),
    );
    const rendered = instructionSegments(store, rules, target.projectId, true);
    errors.push(...rendered.errors);
    return rendered.segments;
  });
  generated = blocks[0] || [];
  if (blocks.some((b) => segmentsText(b) !== segmentsText(generated)))
    errors.push(
      `共用指令文件的工具需选择一致的规则：${target.harnesses.join("、")}`,
    );
  let segments: Segment[] = [];
  try {
    const block = readable ? managedBlock(before) : null;
    const receipt = store
      .state()
      .receipts.find(
        (r) => r.path === target.path && r.kind === "instructions",
      );
    if (block && !receipt)
      errors.push("发现未登记的管理区块，请先检查部署历史");
    if (receipt && hash(block || "") !== receipt.hash)
      errors.push("指令管理区块被外部修改，请先处理部署偏离");
    const replacement = store
      .state()
      .instructionReplacements?.find((r) => r.path === target.path);
    if (replacement && hash(before) !== replacement.hash)
      errors.push("全局指令已在扫描后变化，请重新扫描再登记替换");
    if (replacement && !generated.length)
      errors.push("替换全局指令前，需要先保存适用的源片段");
    if (replacement && generated.length) {
      segments = [...generated, textSegment("frame", "\n")];
    } else if (block && !generated.length && !receipt) {
      segments = [textSegment("native", before)];
    } else if (block) {
      const start = before.indexOf(block),
        end = start + block.length;
      if (start) segments.push(textSegment("native", before.slice(0, start)));
      segments.push(...generated);
      if (end < before.length)
        segments.push(textSegment("native", before.slice(end)));
      if (
        !generated.length &&
        receipt?.instructionCreated &&
        !segmentsText(segments).trim()
      )
        segments = [];
    } else {
      if (before) segments.push(textSegment("native", before));
      if (generated.length) {
        const separator = `${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}`;
        if (separator) segments.push(textSegment("frame", separator));
        segments.push(...generated, textSegment("frame", "\n"));
      }
    }
  } catch (e: any) {
    errors.push(e.message);
    segments = [
      ...(before ? [textSegment("native", before)] : []),
      ...generated,
    ];
  }
  for (const segment of segments)
    for (const part of segment.parts)
      totals[part.type === "variable" ? "variable" : segment.kind] +=
        Buffer.byteLength(part.text);
  const after = segmentsText(segments);
  return {
    ...target,
    exists: present,
    pending: before !== after,
    bytes: Buffer.byteLength(after),
    totals,
    segments,
    ...(errors.length ? { error: [...new Set(errors)].join("；") } : {}),
  };
}

export function instructionCompositions(
  store: Store,
): InstructionComposition[] {
  return instructionTargets(store).map((target) =>
    composeInstruction(store, target),
  );
}
export function instructionComposition(
  store: Store,
  file: string,
): InstructionComposition {
  const target = instructionTargets(store).find(
    (t) => t.path === path.resolve(file),
  );
  if (!target) throw new AppError("NOT_FOUND", "未找到本机指令输出路径", 404);
  return composeInstruction(store, target);
}

function skillFileKind(relative: string, executable: boolean): SkillFileKind {
  if (relative === "SKILL.md") return "instructions";
  if (isCredentialPath(relative)) return "credential";
  const extension = path.posix.extname(relative).toLowerCase();
  if (
    executable ||
    relative.startsWith("scripts/") ||
    [".sh", ".py", ".js", ".mjs", ".ts", ".rb", ".ps1"].includes(extension)
  )
    return "script";
  if (relative.startsWith("references/") || [".md", ".txt"].includes(extension))
    return "reference";
  if (
    relative.startsWith("assets/") ||
    [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".svg",
      ".ico",
      ".bmp",
      ".avif",
      ".tif",
      ".tiff",
      ".woff",
      ".woff2",
      ".ttf",
      ".otf",
      ".eot",
      ".mp3",
      ".wav",
      ".ogg",
      ".flac",
      ".aac",
      ".m4a",
      ".mp4",
      ".webm",
      ".mov",
      ".pdf",
      ".zip",
      ".gz",
      ".wasm",
      ".bin",
    ].includes(extension)
  )
    return "asset";
  return "other";
}

export function skillComposition(store: Store, id: string): SkillComposition {
  const skill = store.manifest().skills.find((s) => s.id === id);
  if (!skill) throw new AppError("NOT_FOUND", "Skill 不存在", 404);
  const root = store.skillPath(id);
  noSymlink(root);
  const result: SkillComposition = {
    id,
    name: skill.name,
    bytes: 0,
    totals: {
      instructions: 0,
      script: 0,
      reference: 0,
      asset: 0,
      credential: 0,
      other: 0,
      variable: 0,
    },
    files: [],
  };
  const walk = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      noSymlink(file);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile())
        throw new AppError("SPECIAL_FILE", `不支持特殊文件：${file}`);
      const stat = fs.statSync(file);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const executable = Boolean(stat.mode & 0o111);
      const kind = skillFileKind(relative, executable);
      let bytes = stat.size,
        variableBytes = 0;
      let variables: string[] = [];
      if (kind === "instructions") {
        const rendered = renderParts(
          store,
          fs.readFileSync(file, "utf8"),
          skill.scope.kind === "project" ? skill.scope.target : undefined,
          { skill: true },
        );
        bytes = Buffer.byteLength(partsText(rendered.parts));
        variables = [
          ...new Set(
            rendered.parts
              .filter((p) => p.type === "variable")
              .map((p) => p.key!),
          ),
        ];
        variableBytes = rendered.parts
          .filter((p) => p.type === "variable")
          .reduce((n, p) => n + Buffer.byteLength(p.text), 0);
      }
      result.bytes += bytes;
      result.totals[kind] += bytes - variableBytes;
      result.totals.variable += variableBytes;
      result.files.push({
        path: relative,
        bytes,
        kind,
        executable,
        variables,
        syncIgnored: false,
      });
    }
  };
  walk(root);
  return result;
}

export function compositionBar(totals: Record<string, number>) {
  const labels: Record<string, string> = {
    native: "原生",
    shared: "共享",
    harness: "工具",
    device: "设备",
    project: "项目",
    frame: "框架",
    variable: "变量",
    instructions: "指令",
    script: "脚本",
    reference: "参考",
    asset: "资源",
    credential: "凭证",
    other: "其他",
  };
  const symbols: Record<string, string> = {
    native: "N",
    shared: "S",
    harness: "H",
    device: "D",
    project: "P",
    frame: "F",
    variable: "V",
    instructions: "I",
    script: "C",
    reference: "R",
    asset: "A",
    credential: "K",
    other: "O",
  };
  const entries = Object.entries(totals).filter(([, n]) => n > 0);
  const bytes = entries.reduce((sum, [, n]) => sum + n, 0);
  let position = 0;
  const legend: string[] = [];
  const bar = entries
    .map(([kind, n], index) => {
      const end = Math.round(
        (entries.slice(0, index + 1).reduce((sum, [, size]) => sum + size, 0) /
          bytes) *
          40,
      );
      const symbol = symbols[kind];
      legend.push(`${symbol} ${labels[kind]} ${n} B`);
      const part = symbol.repeat(end - position);
      position = end;
      return part;
    })
    .join("");
  return `[${bar || " ".repeat(40)}] ${bytes} B\n${legend.join(" · ")}`;
}
