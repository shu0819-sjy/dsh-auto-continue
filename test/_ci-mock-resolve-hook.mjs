/**
 * ESM resolve hook for CI: map @deepseek-ai/* → local test/mocks stubs.
 * Used by test/ci-mock.mjs so auto-continue behavior tests run without DSH.
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MOCKS = {
  "@deepseek-ai/schemastery": join(here, "mocks", "schemastery.mjs"),
  "@deepseek-ai/dsh-llm": join(here, "mocks", "dsh-llm.mjs"),
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = MOCKS[specifier];
  if (mapped) {
    return {
      shortCircuit: true,
      url: pathToFileURL(mapped).href,
    };
  }
  return nextResolve(specifier, context);
}
