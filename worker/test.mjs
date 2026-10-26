import { analyze } from "./src/index.js";
import { readFileSync } from "fs";
import assert from "assert";
const f = n => readFileSync(new URL(`../tests/fixtures/${n}.html`, import.meta.url), "utf8");
let a = analyze(f("present")); assert(a.forms === 1 && a.submit && a.script);
a = analyze(f("missing")); assert(a.forms === 0);
a = analyze(f("broken")); assert(a.forms === 1 && (!a.submit || !a.script));
console.log("worker analyze tests OK");
