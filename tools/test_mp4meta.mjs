// 사용법: node tools/test_mp4meta.mjs
// 회전·편집 목록·B-프레임(ctts)·가변 프레임 속도를 담은 합성 moov로 mp4meta.js를 검사한다.
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, "..", "lib", "mp4meta.js")).href);
const { Mp4Meta } = globalThis;

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const i32 = (n) => u32(n >>> 0);
const str = (s) => [...s].map((c) => c.charCodeAt(0));
const box = (type, ...parts) => {
  const body = parts.flat();
  return [...u32(8 + body.length), ...str(type), ...body];
};
const full = (type, version, ...parts) => box(type, [version, 0, 0, 0], ...parts);
const fx = (v) => i32(Math.round(v * 65536));

function makeMoov({ rotation90, elst, stts, ctts, codec = "hvc1" }) {
  const matrix = rotation90
    ? [...fx(0), ...fx(1), ...u32(0), ...fx(-1), ...fx(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)]
    : [...fx(1), ...fx(0), ...u32(0), ...fx(0), ...fx(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  const tkhd = full("tkhd", 0, u32(0), u32(0), u32(1), u32(0), u32(0), new Array(8).fill(0), [0, 0, 0, 0, 0, 0, 0, 0], matrix, fx(rotation90 ? 1080 : 1920), fx(rotation90 ? 1920 : 1080));
  const edts = elst ? box("edts", full("elst", 0, u32(elst.length), elst.flatMap((e) => [...u32(e[0]), ...i32(e[1]), ...fx(1)]))) : [];
  const mdhd = full("mdhd", 0, u32(0), u32(0), u32(600), u32(0), [0, 0, 0, 0]);
  const hdlr = full("hdlr", 0, u32(0), str("vide"), new Array(12).fill(0), [0]);
  const entry = box(codec, new Array(6).fill(0), [0, 1], new Array(16).fill(0), [7, 128], [4, 56], new Array(50).fill(0));
  const stsd = full("stsd", 0, u32(1), entry);
  const sttsB = full("stts", 0, u32(stts.length), stts.flatMap(([c, d]) => [...u32(c), ...u32(d)]));
  const cttsB = ctts ? full("ctts", 0, u32(ctts.length), ctts.flatMap(([c, o]) => [...u32(c), ...i32(o)])) : [];
  const stbl = box("stbl", stsd, sttsB, cttsB);
  const mdia = box("mdia", mdhd, hdlr, box("minf", stbl));
  const trak = box("trak", tkhd, edts, mdia);
  const mvhd = full("mvhd", 0, u32(0), u32(0), u32(1000), u32(0), new Array(80).fill(0));
  return new Uint8Array(box("moov", mvhd, trak));
}

// 1) 아이폰형: 세로 촬영(90° 회전), HEVC, B-프레임, 편집 목록, 60fps(timescale 600 → 간격 10)
{
  // 디코딩 순서 I0 P3 B1 B2 → 표시 순서 I0 B1 B2 P3 (ctts 20, 40, 10, 10)
  const n = 12;
  const moov = makeMoov({
    rotation90: true,
    stts: [[n, 10]],
    ctts: [[1, 20], [1, 40], [1, 10], [1, 10], [1, 20], [1, 40], [1, 10], [1, 10], [1, 20], [1, 40], [1, 10], [1, 10]],
    elst: [[100, 20]], // media_time = 20: B-프레임 때문에 밀린 표시 시각을 0초로 당김
  });
  const info = Mp4Meta.parseMoov(moov, null);
  assert.equal(info.codec, "hvc1");
  assert.equal(info.rotation, 90);
  assert.equal(info.codedWidth, 1920);
  assert.equal(info.codedHeight, 1080);
  assert.equal(info.sampleCount, n);
  assert.ok(info.hasCtts);
  assert.equal(info.frames[0], 0, "편집 목록 시작이 0초가 되어야 함");
  assert.ok(Math.abs(info.fps - 60) < 1e-9);
  assert.equal(info.vfr, false);
  for (let i = 1; i < info.frames.length; i++) assert.ok(info.frames[i] > info.frames[i - 1], "표시 시각이 오름차순");
  console.log("통과: 아이폰형 (회전·HEVC·ctts·elst)", info.frames.length, "frames");
}

// 2) 안드로이드형: 가변 프레임 속도 (간격 16, 17, 18, 15, 33 ms …), 빈 편집으로 0.1 s 지연
{
  const moov = makeMoov({
    rotation90: false,
    codec: "avc1",
    stts: [[3, 10], [1, 11], [2, 9], [1, 20], [5, 10]], // timescale 600
    elst: [[100, -1], [500, 0]], // 앞 100/1000 s = 0.1 s 비어 있음
  });
  const info = Mp4Meta.parseMoov(moov, null);
  assert.equal(info.codec, "avc1");
  assert.equal(info.rotation, 0);
  assert.ok(Math.abs(info.frames[0] - 0.1) < 1e-9, "빈 편집 지연 0.1 s 반영");
  assert.equal(info.vfr, true);
  assert.ok(info.deltaStats.irregular >= 1);
  const pick = Mp4Meta.pickByStep(info.frames, 0, 0.05, 5);
  for (let k = 1; k < pick.length; k++) {
    const dt = info.frames[pick[k]] - info.frames[pick[0]];
    assert.ok(Math.abs(dt - 0.05 * k) <= 0.025, `0.05 s 배수에 가까운 프레임 선택 (${dt.toFixed(4)})`);
  }
  console.log("통과: 안드로이드형 (VFR·빈 편집) 선택:", pick.join(", "));
}

console.log("모두 통과");
