// Node ESM loader hook that stubs `openclaw/plugin-sdk/plugin-entry` so
// `dist/index.js` can be imported in CI (where the real `openclaw` package
// is not published to npm — it lives inside the OpenClaw runtime only).
//
// The stub returns the config passed to `definePluginEntry` unchanged, which
// matches the runtime behaviour closely enough for smoke to exercise the
// plugin's register() flow.

export function resolve(specifier, context, nextResolve) {
  if (specifier === "openclaw/plugin-sdk/plugin-entry") {
    return {
      url: "data:text/javascript,export function definePluginEntry(cfg){return cfg;}",
      shortCircuit: true,
      format: "module",
    };
  }
  return nextResolve(specifier, context);
}
