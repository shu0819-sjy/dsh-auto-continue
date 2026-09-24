/**
 * ESM resolve hook：把 @deepseek-ai/* 解析到 DSH 安装根的 node_modules。
 * 由各测试在动态 import 插件前 register；__DSH_NODE_MODULES__ 由测试写入。
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  const nm = process.env.__DSH_NODE_MODULES__;
  if (nm && specifier.startsWith("@deepseek-ai/")) {
    const dshRoot = join(nm, "..");
    return nextResolve(specifier, {
      ...context,
      parentURL: pathToFileURL(join(dshRoot, "package.json")).href
    });
  }
  return nextResolve(specifier, context);
}
