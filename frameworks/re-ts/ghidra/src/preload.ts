// bunfig.toml: preload = ["@aphrody/ghidra/preload"]  -> enables `?ghidra` and `ghidra:` imports at runtime.
import { plugin } from "bun";
import { ghidraPlugin } from "./plugin.ts";
plugin(ghidraPlugin());
