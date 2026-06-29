// Node module-resolution hook: map the bare `yaml` specifier to the vendored copy
// so the v3 ESM modules (js/protocol-yaml-v3.js, js/v3-import.js) load without a
// node_modules install. In the browser the same bare specifier is resolved by the
// import map in experiment_designer_v3.html; this hook is the Node-side equivalent,
// and points at the very same vendored browser build the import map uses.

const YAML_URL = new URL('../js/vendor/yaml/browser/dist/index.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'yaml') {
        return { url: YAML_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
