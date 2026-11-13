import { createContext, useContext } from "react";
import type { Scope, Skill, Snapshot } from "../shared/types.ts";
import type { Page, api } from "./lib.ts";
import type { UpdateCheck } from "./SkillSources.tsx";

export type Modal = { type: string; item?: any } | null;

// Everything the pages share with the shell. Only the shell owns state; pages
// read it here instead of receiving a dozen props each.
export type AppContextValue = {
  data: Snapshot;
  busy: boolean;
  api: typeof api;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
  fire: (fn: () => Promise<unknown>, message?: string) => void;
  refresh: () => Promise<Snapshot>;
  setPage: (page: Page) => void;
  setModal: (modal: Modal) => void;
  openPlan: () => void;
  openScan: () => void;
  editSkill: (skill: Skill) => void;
  changeEnabled: (skill: Skill) => void;
  remove: (type: string, item: any) => void;
  scopeText: (scope: Scope) => string;
  updates: Record<string, UpdateCheck>;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside AppContext");
  return value;
}
