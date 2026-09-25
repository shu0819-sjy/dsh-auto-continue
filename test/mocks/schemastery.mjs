/**
 * Minimal schemastery stub for CI — enough for auto-continue Config({}).
 * Real package lives under @deepseek-ai/schemastery inside a DSH install.
 */

function chain(def) {
  const api = {
    _def: def,
    default(v) {
      return chain(v);
    },
    step() {
      return api;
    },
    min() {
      return api;
    },
    max() {
      return api;
    },
  };
  return api;
}

function object(shape) {
  return function parse(input = {}) {
    const out = {};
    for (const [key, schema] of Object.entries(shape)) {
      out[key] = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : schema._def;
    }
    return out;
  };
}

const z = {
  boolean: () => chain(undefined),
  string: () => chain(undefined),
  number: () => chain(undefined),
  array: () => chain(undefined),
  object,
};

export default z;
