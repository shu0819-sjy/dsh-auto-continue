/**
 * 共享：探测 DSH node_modules，供测试在 register resolve hook 前调用。
 * 候选：DSH_HOME 上级 / DSH_HOME 自身 / 本机常见安装路径。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export function findDshNodeModules() {
  const candidates = [];
  if (process.env.DSH_HOME) {
    candidates.push(join(process.env.DSH_HOME, "..", "node_modules"));
    candidates.push(join(process.env.DSH_HOME, "node_modules"));
  }
  // 发现/回退候选（本机常见 DSH 安装位置）
  candidates.push(join("D:", "DeepSeek-Harness", "node_modules"));

  for (const c of candidates) {
    if (existsSync(join(c, "@deepseek-ai"))) return c;
  }
  return null;
}

export function requireDshNodeModules() {
  const nm = findDshNodeModules();
  if (!nm) {
    console.error("需在装有 DSH 的机器上运行，可用 DSH_HOME 指定数据目录");
    process.exit(1);
  }
  process.env.__DSH_NODE_MODULES__ = nm;
  return nm;
}
