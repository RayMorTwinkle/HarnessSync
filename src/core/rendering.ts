import type { Store } from "./store.ts";
import { harnessIds, type Rule, type Scope } from "../shared/types.ts";
import type { Part, Segment } from "./composition.ts";
import { selectedHarnesses } from "./harness-registry.ts";
import { AppError, noSymlink, readBundle, type Bundle } from "./files.ts";

export const START = "<!-- harness-sync:begin -->";
export const END = "<!-- harness-sync:end -->";
export const partsText = (parts: Part[]) => parts.map((p) => p.text).join("");
export const segmentsText = (segments: Segment[]) =>
  segments.map((s) => partsText(s.parts)).join("");

// A context belongs to one read operation. Never retain it on Engine or Store.
export function renderContext(
  store: Store,
  manifest = store.manifest(),
  device = store.device(),
) {
  const projects = new Map<string, string>();
  for (const project of manifest.projects)
    if (!projects.has(project.id)) projects.set(project.id, project.name);
  const variables = new Map<string, string>([
    ["device.name", device.name],
    ["device.id", device.id],
    ["device.home", device.home],
  ]);
  for (const [key, value] of Object.entries(device.variables))
    variables.set(`vars.${key}`, value);

  const selections = new Map<string, string[]>();
  function select(ids: string[]) {
    const key = JSON.stringify(ids);
    let selected = selections.get(key);
    if (!selected) {
      selected = selectedHarnesses(
        ids,
        store.home,
        store.root,
        device.disabledHarnesses,
      );
      selections.set(key, selected);
    }
    return selected;
  }
  return {
    device,
    manifest,
    order: new Map((device.ruleOrder || []).map((id, i) => [id, i])),
    select,
    value(key: string, projectId?: string) {
      if (key === "project.name")
        return projectId ? projects.get(projectId) : undefined;
      if (key === "project.path")
        return projectId ? device.bindings[projectId] : undefined;
      return variables.get(key);
    },
  };
}
export type RenderContext = ReturnType<typeof renderContext>;

export function renderParts(
  context: RenderContext,
  text: string,
  projectId?: string,
  options: { skill?: boolean; partial?: boolean } = {},
) {
  const parts: Part[] = [];
  const errors: string[] = [];
  const pattern = options.skill
    ? /\{\{\s*(vars\.\w+|device\.(?:name|id|home)|project\.(?:name|path))\s*\}\}/g
    : /\{\{\s*([\w.]+)\s*\}\}/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    if (options.skill && !projectId && key.startsWith("project.")) continue;
    if (match.index > offset)
      parts.push({ type: "text", text: text.slice(offset, match.index) });
    const value = context.value(key, projectId);
    if (value === undefined) {
      const message = `缺少变量 {{${key}}}，请在设备设置中添加${key.startsWith("vars.") ? `变量 ${key.slice(5)}（hsync device set ${key.slice(5)} <值>）` : "对应的设备信息或项目绑定"}`;
      if (!options.partial) throw new AppError("MISSING_VARIABLE", message);
      errors.push(message);
      parts.push({ type: "text", text: match[0] });
    } else parts.push({ type: "variable", key, text: value });
    offset = match.index + match[0].length;
  }
  if (offset < text.length)
    parts.push({ type: "text", text: text.slice(offset) });
  return { parts, errors: [...new Set(errors)] };
}

export function renderedSkillBundle(
  store: Store,
  id: string,
  projectId?: string,
): Bundle {
  noSymlink(store.skillPath(id));
  const bundle = readBundle(store.skillPath(id));
  const file = bundle["SKILL.md"];
  if (!file) throw new AppError("INVALID_SKILL", "目录中缺少 SKILL.md");
  bundle["SKILL.md"] = {
    ...file,
    content: Buffer.from(
      renderSkillText(
        store,
        Buffer.from(file.content, "base64").toString("utf8"),
        projectId,
      ),
    ).toString("base64"),
  };
  return bundle;
}

export function renderSkillText(
  store: Store,
  text: string,
  projectId?: string,
) {
  // A missing variable keeps its placeholder: skills often quote the syntax
  // in prose, and a new device should still get every skill.
  return partsText(
    renderParts(renderContext(store), text, projectId, {
      skill: true,
      partial: true,
    }).parts,
  );
}

export function matchesScope(
  context: RenderContext,
  scope: Scope,
  harness: string,
  projectId?: string,
) {
  if (!context.select(scope.harnesses).includes(harness)) return false;
  return projectId
    ? scope.kind === "project" && scope.target === projectId
    : scope.kind === "global" ||
        (scope.kind === "device" && scope.target === context.device.id);
}

export function segment(
  kind: Segment["kind"],
  parts: Part[],
  rule?: Rule,
): Segment {
  return {
    kind,
    parts,
    bytes: Buffer.byteLength(partsText(parts)),
    ...(rule
      ? {
          ruleId: rule.id,
          title: rule.title,
          harnesses: rule.scope.harnesses,
          scope: {
            kind: rule.scope.kind,
            ...(rule.scope.target ? { target: rule.scope.target } : {}),
          },
        }
      : {}),
  };
}
export const textSegment = (kind: Segment["kind"], text: string) =>
  segment(kind, [{ type: "text", text }]);

function trimParts(parts: Part[]) {
  const text = partsText(parts);
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  let offset = 0;
  return parts.flatMap((part) => {
    const from = Math.max(0, start - offset);
    const to = Math.min(part.text.length, end - offset);
    offset += part.text.length;
    return to > from ? [{ ...part, text: part.text.slice(from, to) }] : [];
  });
}

export function instructionSegments(
  context: RenderContext,
  rules: Rule[],
  projectId?: string,
  partial = false,
) {
  if (!rules.length)
    return { segments: [] as Segment[], errors: [] as string[] };
  const { order } = context;
  const enabled = context.select([...harnessIds]);
  const sorted = [...rules].sort(
    (a, b) =>
      Number(a.scope.kind === "device") - Number(b.scope.kind === "device") ||
      (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
  );
  const segments: Segment[] = [
    textSegment("frame", `${START}\n# HarnessSync\n\n`),
  ];
  const errors: string[] = [];
  sorted.forEach((rule, i) => {
    segments.push(
      textSegment("frame", `${i ? "\n\n" : ""}## ${rule.title}\n\n`),
    );
    const rendered = renderParts(context, rule.body, projectId, { partial });
    errors.push(...rendered.errors);
    const selected = context.select(rule.scope.harnesses);
    const kind =
      rule.scope.kind === "device"
        ? "device"
        : rule.scope.kind === "project"
          ? "project"
          : enabled.every((id) => selected.includes(id))
            ? "shared"
            : "harness";
    segments.push(segment(kind, trimParts(rendered.parts), rule));
  });
  const content = segmentsText(segments).slice(
    `${START}\n# HarnessSync\n\n`.length,
  );
  if (Buffer.byteLength(content) > 48 * 1024)
    errors.push("合成指令超过 48 KiB，请拆分为按需加载的 Skills");
  if (content.includes(START) || content.includes(END))
    errors.push("指令正文不能包含 HarnessSync 保留标记");
  if (!partial && errors.length)
    throw new AppError(
      Buffer.byteLength(content) > 48 * 1024
        ? "INSTRUCTIONS_TOO_LARGE"
        : "RESERVED_MARKER",
      errors[0],
    );
  segments.push(textSegment("frame", `\n${END}`));
  return { segments, errors: [...new Set(errors)] };
}

export function managedBlock(text: string) {
  const starts = text.split(START).length - 1,
    ends = text.split(END).length - 1;
  if (!starts && !ends) return null;
  if (starts !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(START))
    throw new AppError(
      "MALFORMED_BLOCK",
      "HarnessSync 管理区块标记损坏或重复，请先修复",
    );
  return text.slice(text.indexOf(START), text.indexOf(END) + END.length);
}
export function replaceBlock(text: string, block: string | null) {
  const previous = managedBlock(text);
  if (previous) return text.replace(previous, () => block || "");
  return block
    ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`
    : text;
}
