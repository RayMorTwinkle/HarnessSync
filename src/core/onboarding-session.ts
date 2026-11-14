import path from "node:path";
import type { Store } from "./store.ts";
import { AppError, noSymlink, writeJson } from "./files.ts";

export const onboardingPauseReason = "初始化进行中：确认部署预览后再写入";
export const onboardingLifetime = 7 * 24 * 60 * 60 * 1000;
export function activeOnboarding(store: Store) {
  const session = store.state().onboarding;
  return session && Date.parse(session.expiresAt) > Date.now() ? session : null;
}
export async function cancelOnboarding(store: Store, id: string) {
  return store.lock(() => {
    noSymlink(path.join(store.root, "state.json"));
    const state = store.state();
    if (state.onboarding?.id !== id)
      throw new AppError(
        "ONBOARDING_SESSION",
        "初始化会话已结束或 ID 不匹配",
        409,
      );
    delete state.onboarding;
    writeJson(path.join(store.root, "state.json"), state);
    return {
      id,
      note: "已放弃初始化会话；自动部署恢复原有设置，源配置和替换登记保留，请检查 plan",
    };
  });
}
