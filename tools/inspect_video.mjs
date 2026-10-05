// 사용법: node tools/inspect_video.mjs <영상 파일>
// mp4meta.js로 프레임 시각표를 읽어 요약을 출력한다.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, "..", "phase0", "mp4meta.js")).href);
const { Mp4Meta } = globalThis;

const buf = readFileSync(process.argv[2]);
const file = new Blob([buf]);
const info = await Mp4Meta.readFile(file);
const { frames, ...rest } = info;
console.log(JSON.stringify(rest, null, 2));
console.log("처음 5프레임:", frames.slice(0, 5).map((t) => t.toFixed(4)).join(", "));
console.log("0.05 s 간격 선택:", Mp4Meta.pickByStep(frames, 0, 0.05, 12).join(", "));
