// Registers vendor-yaml.hooks.mjs so `import 'yaml'` resolves to the vendored copy.
// Used via `node --import ./tests/vendor-yaml.register.mjs <test>` for the v3 suite,
// which pulls in the ESM modules that import the bare `yaml` specifier.
import { register } from 'node:module';

register('./vendor-yaml.hooks.mjs', import.meta.url);
