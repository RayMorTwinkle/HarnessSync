export function skillCommitMessage(action: string, names: string[]) {
  const prefix = `${action}：`;
  const full = prefix + names.join("、");
  if (full.length <= 100) return full;
  const suffix = ` 等 ${names.length} 个`;
  const shown: string[] = [];
  let length = prefix.length + suffix.length;
  for (const name of names) {
    const extra = name.length + (shown.length ? 1 : 0);
    if (length + extra > 100) break;
    shown.push(name);
    length += extra;
  }
  return prefix + shown.join("、") + suffix;
}
