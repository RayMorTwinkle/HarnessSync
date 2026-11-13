import type { Snapshot } from "../shared/types.ts";

export type Page =
  | "overview"
  | "skills"
  | "instructions"
  | "projects"
  | "onboarding"
  | "sync"
  | "history"
  | "device";

export async function api<T>(
  route: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? "GET" : method,
    headers: {
      "x-harness-sync-token":
        document.querySelector<HTMLMetaElement>("meta[name=harness-sync-token]")
          ?.content || "",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!value.ok) throw new Error(value.message || "操作失败");
  return value.data;
}

export const time = (date?: string) =>
  date
    ? new Date(date).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未部署";

export const allHarnessIds = (data: Snapshot) =>
  data.harnesses.map((h) => h.id);
export const harnessName = (data: Snapshot, id: string) =>
  data.harnesses.find((h) => h.id === id)?.name || id;
