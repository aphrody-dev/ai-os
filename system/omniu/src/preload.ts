// Bun preload (bunfig.toml `preload`): registers every plugin of the bundle that declares a [bun] entry.
import { loadBunPlugins } from "./host.ts";

await loadBunPlugins();
