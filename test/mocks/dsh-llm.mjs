/**
 * Minimal @deepseek-ai/dsh-llm stub for CI mock suite.
 * createUserMessage only needs to echo content/source for followup asserts.
 */
export function createUserMessage({ content, source }) {
  return { content, source };
}
