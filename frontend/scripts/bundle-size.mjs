import { gzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const bundlePath = resolve(process.cwd(), "../javascript/prompt_agent_90_ui.js");
const maxGzipBytes = Number(process.env.PROMPT_AGENT_MAX_GZIP_BYTES ?? 350_000);
const source = await readFile(bundlePath);
const compressed = gzipSync(source, { level: 9 });
const file = await stat(bundlePath);

console.log(`bundle: ${bundlePath}`);
console.log(`raw bytes: ${file.size}`);
console.log(`gzip bytes: ${compressed.length}`);
if (compressed.length > maxGzipBytes) {
  throw new Error(`bundle gzip size ${compressed.length} exceeds ${maxGzipBytes} bytes`);
}
