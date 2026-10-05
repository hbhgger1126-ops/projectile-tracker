/*
 * mp4meta.js — MP4/MOV 컨테이너에서 영상 트랙의 프레임 시각표를 읽는다.
 *
 * 브라우저: Mp4Meta.readFile(file) → Promise<info>
 * Node:     Mp4Meta.parseMoov(moovBytes, ftypBytes)
 *
 * info.frames: 표시 순서로 정렬된 각 프레임의 표시 시각(초, 편집 목록 반영)
 */
(function (root) {
  "use strict";

  const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

  function fourcc(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }

  function u64(dv, off) {
    return dv.getUint32(off) * 2 ** 32 + dv.getUint32(off + 4);
  }

  function i64(dv, off) {
    return dv.getInt32(off) * 2 ** 32 + dv.getUint32(off + 4);
  }

  // [start, end) 범위의 자식 박스들
  function* boxes(dv, start, end) {
    let off = start;
    while (off + 8 <= end) {
      let size = dv.getUint32(off);
      const type = fourcc(dv, off + 4);
      let header = 8;
      if (size === 1) {
        size = u64(dv, off + 8);
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return;
      yield { type, start: off, body: off + header, end: off + size };
      off += size;
    }
  }

  function child(dv, box, type) {
    for (const b of boxes(dv, box.body, box.end)) if (b.type === type) return b;
    return null;
  }

  function children(dv, box, type) {
    const out = [];
    for (const b of boxes(dv, box.body, box.end)) if (b.type === type) out.push(b);
    return out;
  }

  function path(dv, box, ...types) {
    let b = box;
    for (const t of types) {
      b = child(dv, b, t);
      if (!b) return null;
    }
    return b;
  }

  function parseMvhd(dv, b) {
    const v = dv.getUint8(b.body);
    return v === 1
      ? { timescale: dv.getUint32(b.body + 20), duration: u64(dv, b.body + 24) }
      : { timescale: dv.getUint32(b.body + 12), duration: dv.getUint32(b.body + 16) };
  }

  function parseTkhd(dv, b) {
    const v = dv.getUint8(b.body);
    const p = b.body + (v === 1 ? 4 + 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4 + 4);
    // reserved 8, layer 2, alt 2, volume 2, reserved 2, matrix 36, width 4, height 4
    const m = p + 16;
    const a = dv.getInt32(m) / 65536, bb = dv.getInt32(m + 4) / 65536;
    const c = dv.getInt32(m + 12) / 65536, d = dv.getInt32(m + 16) / 65536;
    let rotation = Math.round((Math.atan2(bb, a) * 180) / Math.PI);
    if (rotation < 0) rotation += 360;
    return {
      width: dv.getUint32(m + 36) / 65536,
      height: dv.getUint32(m + 40) / 65536,
      rotation,
      matrix: [a, bb, c, d],
    };
  }

  function parseMdhd(dv, b) {
    const v = dv.getUint8(b.body);
    return v === 1
      ? { timescale: dv.getUint32(b.body + 20), duration: u64(dv, b.body + 24) }
      : { timescale: dv.getUint32(b.body + 12), duration: dv.getUint32(b.body + 16) };
  }

  function parseStsd(dv, b) {
    const entry = b.body + 8;
    if (entry + 8 > b.end) return null;
    const codec = fourcc(dv, entry + 4);
    // VisualSampleEntry: 8(header) + 6 reserved + 2 dref + 16 predefined/reserved → width, height
    const width = dv.getUint16(entry + 32);
    const height = dv.getUint16(entry + 34);
    return { codec, width, height };
  }

  function parseStts(dv, b) {
    const n = dv.getUint32(b.body + 4);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = b.body + 8 + i * 8;
      out.push([dv.getUint32(p), dv.getUint32(p + 4)]);
    }
    return out;
  }

  function parseCtts(dv, b) {
    const v = dv.getUint8(b.body);
    const n = dv.getUint32(b.body + 4);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = b.body + 8 + i * 8;
      // 버전 0도 실제로는 음수를 쓰는 인코더가 있어 부호 있는 값으로 읽는다
      out.push([dv.getUint32(p), v === 1 ? dv.getInt32(p + 4) : dv.getInt32(p + 4)]);
    }
    return out;
  }

  function parseElst(dv, b) {
    const v = dv.getUint8(b.body);
    const n = dv.getUint32(b.body + 4);
    const out = [];
    let p = b.body + 8;
    for (let i = 0; i < n; i++) {
      if (v === 1) {
        out.push({ segmentDuration: u64(dv, p), mediaTime: i64(dv, p + 8), rate: dv.getInt32(p + 16) / 65536 });
        p += 20;
      } else {
        out.push({ segmentDuration: dv.getUint32(p), mediaTime: dv.getInt32(p + 4), rate: dv.getInt32(p + 8) / 65536 });
        p += 12;
      }
    }
    return out;
  }

  function handlerType(dv, mdia) {
    const h = child(dv, mdia, "hdlr");
    return h ? fourcc(dv, h.body + 8) : null;
  }

  function parseMoov(moovBytes, ftypBytes) {
    const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    const moov = { type: "moov", start: 0, body: 8, end: dv.byteLength };
    if (dv.getUint32(0) === 1) moov.body = 16;

    const info = { brand: null, compatibleBrands: [], fragmented: false };
    if (ftypBytes) {
      const fv = new DataView(ftypBytes.buffer, ftypBytes.byteOffset, ftypBytes.byteLength);
      info.brand = fourcc(fv, 8);
      for (let p = 16; p + 4 <= fv.byteLength; p += 4) info.compatibleBrands.push(fourcc(fv, p));
    }

    const mvhdBox = child(dv, moov, "mvhd");
    const mvhd = mvhdBox ? parseMvhd(dv, mvhdBox) : { timescale: 1000, duration: 0 };
    info.fragmented = !!child(dv, moov, "mvex");

    const trak = children(dv, moov, "trak").find((t) => {
      const mdia = child(dv, t, "mdia");
      return mdia && handlerType(dv, mdia) === "vide";
    });
    if (!trak) throw new Error("영상 트랙을 찾지 못함");

    const tkhd = parseTkhd(dv, child(dv, trak, "tkhd"));
    const mdia = child(dv, trak, "mdia");
    const mdhd = parseMdhd(dv, child(dv, mdia, "mdhd"));
    const stbl = path(dv, mdia, "minf", "stbl");
    const stsdBox = stbl && child(dv, stbl, "stsd");
    const sttsBox = stbl && child(dv, stbl, "stts");
    const cttsBox = stbl && child(dv, stbl, "ctts");
    const elstBox = path(dv, trak, "edts", "elst");

    const stsd = stsdBox ? parseStsd(dv, stsdBox) : null;
    const stts = sttsBox ? parseStts(dv, sttsBox) : [];
    const ctts = cttsBox ? parseCtts(dv, cttsBox) : [];
    const elst = elstBox ? parseElst(dv, elstBox) : [];

    // 디코딩 시각 → 표시 시각
    const ts = mdhd.timescale;
    const dts = [];
    let t = 0;
    for (const [count, delta] of stts) {
      for (let i = 0; i < count; i++) {
        dts.push(t);
        t += delta;
      }
    }
    const endDts = t;
    const cto = new Array(dts.length).fill(0);
    let k = 0;
    for (const [count, off] of ctts) {
      for (let i = 0; i < count && k < cto.length; i++) cto[k++] = off;
    }

    // 편집 목록: 앞쪽 빈 구간(media_time = -1)은 지연, 첫 실제 구간의 media_time은 시작 오프셋
    let emptyDelay = 0;
    let mediaStart = 0;
    for (const e of elst) {
      if (e.mediaTime === -1) {
        emptyDelay += e.segmentDuration / mvhd.timescale;
      } else {
        mediaStart = e.mediaTime;
        break;
      }
    }

    const pts = dts.map((d, i) => d + cto[i]).sort((a, b) => a - b);
    const frames = [];
    for (const p of pts) {
      if (p < mediaStart) continue; // 편집 목록으로 잘려 표시되지 않는 프레임
      frames.push(emptyDelay + (p - mediaStart) / ts);
    }
    // 마지막 프레임이 끝나는 시각 (마지막 표시 시각 + 마지막 간격)
    const lastDelta = stts.length ? stts[stts.length - 1][1] : 0;
    const endTime = frames.length ? frames[frames.length - 1] + lastDelta / ts : 0;

    const deltas = [];
    for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
    const stats = deltaStats(deltas);

    return Object.assign(info, {
      codec: stsd ? stsd.codec : null,
      codedWidth: stsd ? stsd.width : null,
      codedHeight: stsd ? stsd.height : null,
      displayWidth: tkhd.width,
      displayHeight: tkhd.height,
      rotation: tkhd.rotation,
      timescale: ts,
      movieTimescale: mvhd.timescale,
      sampleCount: dts.length,
      hasCtts: ctts.length > 0,
      editList: elst,
      emptyDelay,
      mediaStart: mediaStart / ts,
      duration: endDts / ts,
      endTime,
      frames,
      deltaStats: stats,
      fps: stats.mean ? 1 / stats.mean : null,
      vfr: stats.mean ? (stats.max - stats.min) / stats.mean > 0.1 : false,
    });
  }

  function deltaStats(d) {
    if (!d.length) return { mean: 0, min: 0, max: 0, sd: 0, irregular: 0 };
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    const irregular = d.filter((x) => Math.abs(x - mean) > 0.25 * mean).length;
    return { mean, min: Math.min(...d), max: Math.max(...d), sd, irregular };
  }

  // 0, step, 2·step … 에 가장 가까운 프레임 번호 (가변 프레임 속도 대응)
  function pickByStep(frames, startIndex, step, count) {
    const out = [];
    const t0 = frames[startIndex];
    let j = startIndex;
    for (let n = 0; n < count; n++) {
      const target = t0 + n * step;
      while (j + 1 < frames.length && Math.abs(frames[j + 1] - target) <= Math.abs(frames[j] - target)) j++;
      if (Math.abs(frames[j] - target) > step / 2) break;
      out.push(j);
    }
    return out;
  }

  // 큰 파일도 메모리에 다 올리지 않도록 최상위 박스 헤더만 훑고 moov만 읽는다
  async function readFile(file) {
    const read = async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
    let off = 0;
    let moov = null;
    let ftyp = null;
    const top = [];
    while (off + 8 <= file.size) {
      const h = await read(off, Math.min(off + 16, file.size));
      const dv = new DataView(h.buffer);
      let size = dv.getUint32(0);
      const type = fourcc(dv, 4);
      if (size === 1) size = u64(dv, 8);
      else if (size === 0) size = file.size - off;
      if (size < 8) break;
      top.push(type);
      if (type === "moov") moov = await read(off, off + size);
      if (type === "ftyp") ftyp = await read(off, off + size);
      off += size;
    }
    if (!moov) throw new Error("moov 박스가 없음 (최상위 박스: " + top.join(", ") + ")");
    const info = parseMoov(moov, ftyp);
    info.topLevelBoxes = top;
    info.hasMoof = top.includes("moof");
    return info;
  }

  root.Mp4Meta = { readFile, parseMoov, pickByStep, deltaStats };
})(typeof window !== "undefined" ? window : globalThis);
