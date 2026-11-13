import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { HarnessId } from "../shared/types.ts";
import {
  listManifests,
  registry,
  manifestRoot,
  resolveTemplate,
  resolveProjectPath,
  resolvedHarnesses,
} from "./harness-registry.ts";

export const adapters = resolvedHarnesses;
const versions = new Map<string, string | null>();
export function harnessVersions(
  home = os.homedir(),
  root?: string,
  disabled: string[] = [],
) {
  return Object.fromEntries(
    registry(home, root).entries.map(({ manifest: m, source }) => {
      if (source !== "builtin" || disabled.includes(m.id)) return [m.id, null];
      const key = JSON.stringify(m.version);
      if (!versions.has(key)) {
        try {
          versions.set(
            key,
            m.version
              ? execFileSync(m.version.command, m.version.args, {
                  encoding: "utf8",
                  timeout: 4000,
                  stdio: ["ignore", "pipe", "ignore"],
                }).trim()
              : null,
          );
        } catch {
          versions.set(key, null);
        }
      }
      return [m.id, versions.get(key) ?? null];
    }),
  );
}
export function projectTargets(
  harness: HarnessId,
  dir: string,
  home = os.homedir(),
  root?: string,
) {
  const m = listManifests(home, root).find((m) => m.id === harness);
  if (!m) throw new Error(`未知 Harness：${harness}`);
  return {
    instructions: resolveProjectPath(
      m.instructions.project,
      dir,
      home,
      root,
      "$.instructions.project",
    ),
    skills: resolveProjectPath(
      m.skills.project,
      dir,
      home,
      root,
      "$.skills.project",
    ),
  };
}
export function sharedInstructionPeers(
  harness: HarnessId,
  home = os.homedir(),
  root?: string,
) {
  const manifests = listManifests(home, root);
  const file = manifests.find((m) => m.id === harness)?.instructions.project;
  return manifests
    .filter(
      (m) =>
        file &&
        path.resolve(home, m.instructions.project) === path.resolve(home, file),
    )
    .map((m) => m.id);
}
export type SkillReader = {
  dir: string;
  readers: HarnessId[];
  legacy?: boolean;
};
export function skillReaders(
  home: string,
  projectDir?: string,
  root?: string,
  disabled: string[] = [],
): SkillReader[] {
  const merged = new Map<string, SkillReader>();
  for (const m of listManifests(home, root).filter(
    (m) => !disabled.includes(m.id),
  )) {
    for (const r of projectDir
      ? m.skills.reads.project
      : m.skills.reads.global) {
      const dir = projectDir
        ? resolveProjectPath(
            typeof r === "string" ? r : r.path,
            projectDir,
            home,
            root,
            "$.skills.reads.project",
          )
        : resolveTemplate(
            typeof r === "string" ? r : r.path,
            home,
            manifestRoot(m, home),
            projectDir,
          );
      const legacy = typeof r !== "string" && Boolean(r.legacy);
      const old = merged.get(dir);
      merged.set(dir, {
        dir,
        readers: [...new Set([...(old?.readers || []), m.id])],
        legacy: old ? Boolean(old.legacy && legacy) : legacy,
      });
    }
  }
  const manifests = listManifests(home, root);
  for (const entry of merged.values()) {
    const owners = manifests
      .filter(
        (m) =>
          resolveTemplate(
            projectDir ? m.skills.project : m.skills.global,
            home,
            manifestRoot(m, home),
            projectDir,
          ) === entry.dir,
      )
      .map((m) => m.id);
    entry.readers.sort(
      (a, b) =>
        Number(owners.includes(b)) - Number(owners.includes(a)) ||
        manifests.findIndex((m) => m.id === b) -
          manifests.findIndex((m) => m.id === a),
    );
  }
  return [...merged.values()];
}
// Monotone scores and suffix coverage prune the exact search. BigInt preserves
// the original lowest-subset-index tie break without a 32-bit directory limit.
export function placeSkills(
  selected: HarnessId[],
  readers: SkillReader[],
  collapse = listManifests()
    .filter((m) => m.skills.sameNameCopies === "collapse")
    .map((m) => m.id),
): SkillReader[] {
  if (!selected.length) return [];
  const ids = [...new Set(readers.flatMap((r) => r.readers))];
  const counts = new Map(ids.map((id) => [id, 0]));
  const suffix: Set<string>[] = [new Set()];
  for (const r of readers)
    suffix.push(new Set([...suffix.at(-1)!, ...r.readers]));
  let best: number[] | undefined,
    bestMask = 0n;
  const chosen: number[] = [];
  const compare = (a: number[], b: number[]) => {
    const i = a.findIndex((v, i) => v !== b[i]);
    return i < 0 ? 0 : a[i] - b[i];
  };
  const visit = (i: number, mask: bigint, legacy: number) => {
    const missing = selected.filter((id) => !counts.get(id));
    if (missing.some((id) => !suffix[i + 1].has(id))) return;
    const score = [
      ids.reduce(
        (n, id) =>
          n + (collapse.includes(id) ? 0 : Math.max(0, counts.get(id)! - 1)),
        0,
      ),
      ids.filter((id) => !selected.includes(id) && counts.get(id)).length,
      legacy,
      chosen.length,
    ];
    const lower = [...score];
    lower[3] += missing.length ? 1 : 0;
    if (best && compare(lower, best) > 0) return;
    if (!missing.length) {
      if (
        !best ||
        compare(score, best) < 0 ||
        (compare(score, best) === 0 && mask < bestMask)
      ) {
        best = score;
        bestMask = mask;
      }
      return;
    }
    if (i < 0) return;
    visit(i - 1, mask, legacy);
    const r = readers[i];
    if (!r.readers.some((id) => selected.includes(id) && !counts.get(id)))
      return;
    for (const id of r.readers) counts.set(id, counts.get(id)! + 1);
    chosen.push(i);
    visit(i - 1, mask | (1n << BigInt(i)), legacy + Number(Boolean(r.legacy)));
    chosen.pop();
    for (const id of r.readers) counts.set(id, counts.get(id)! - 1);
  };
  visit(readers.length - 1, 0n, 0);
  if (!best) throw new Error("技能读取目录无法覆盖所选 Harness");
  return readers.filter((_, i) => bestMask & (1n << BigInt(i)));
}
