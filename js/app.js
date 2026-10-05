/*
 * 포물선 운동 분석 — 1단계
 * 영상 → 기준판(스케일) → 공 찍기 → 데이터 표
 *
 * 좌표는 모두 "영상 픽셀"(videoWidth × videoHeight, 회전 반영) 단위로 저장하고,
 * 표를 만들 때만 m로 바꾼다. 그래서 기준판을 나중에 다시 찍어도 공 위치를 다시 찍을 필요가 없다.
 */
(function () {
  "use strict";

  const STEP_DT = 0.05;          // 표의 시간 간격 (활동지와 같이 고정)
  const MAX_POINTS = 12;         // 활동지 표 칸 수
  const MIN_POINTS = 5;          // A·B·C를 정할 수 있는 최소 점 수
  const BOARD_D12 = 0.25;        // 기준판 과녁 1→2 (m)
  const BOARD_D13 = 0.15;        // 기준판 과녁 1→3 (m)
  const TILT_WARN = 0.03;        // 가로·세로 스케일 차이 경고 기준
  const LOUPE_ZOOM = 4;          // 돋보기 배율 (화면 기준)
  const STORE_PREFIX = "pt1:";

  const $ = (id) => document.getElementById(id);
  const video = $("video");
  const overlay = $("overlay");
  const octx = overlay.getContext("2d");
  const loupe = $("loupe");
  const lctx = loupe.getContext("2d");
  const hasRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

  const S = {
    step: "load",
    file: null,
    source: "",
    info: null,
    frames: [],
    index: 0,
    vw: 0,
    vh: 0,
    warnings: [],
    scalePts: [],          // [{x, y}] × 3 (영상 픽셀)
    scaleFrame: null,
    plan: [],              // 공 찍을 프레임 번호 목록 (0.05 s 간격)
    points: [],            // [{frame, x, y}]
    fixRow: null,          // 데이터 표에서 다시 찍는 행 번호
    drag: null,            // 찍는 중인 포인터 {id, type, pos}
    penUntil: 0,           // 펜을 쓴 직후 손바닥 터치 무시
    busy: false,
    pending: null,
    lastMeta: null,
    seekWarn: false,
    objectUrl: null,
  };

  // ---------------------------------------------------------------- 유틸
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const f2 = (v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);

  function once(el, ev, timeout) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error("시간 초과")); }, timeout);
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error("재생 오류")); };
      function cleanup() { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener("error", bad); }
      el.addEventListener(ev, ok);
      el.addEventListener("error", bad);
    });
  }

  // ---------------------------------------------------------------- 영상 열기
  $("filePick").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f, "고른 영상"); });
  $("fileCapture").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f, "촬영한 영상"); });
  $("btnSample").addEventListener("click", async () => {
    $("loadMsg").textContent = "예시 영상을 불러오는 중…";
    try {
      const blob = await (await fetch("samples/sample-throw.mp4")).blob();
      openFile(new File([blob], "예시 영상.mp4", { type: "video/mp4" }), "예시 영상");
    } catch (e) {
      $("loadMsg").textContent = "예시 영상을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.";
    }
  });

  async function openFile(file, source) {
    $("loadMsg").textContent = "영상을 여는 중…";
    let info;
    try {
      info = await Mp4Meta.readFile(file);
      if (info.frames.length < 10) throw new Error("프레임이 너무 적음");
    } catch (e) {
      $("loadMsg").innerHTML = `<b style="color:var(--bad)">이 영상의 프레임 정보를 읽지 못했어요.</b> ` +
        "아이패드는 <b>파일 앱</b>에서 골라 보거나, 설정 &gt; 카메라 &gt; 포맷을 <b>높은 호환성</b>으로 바꿔 다시 찍어 주세요.";
      return;
    }

    if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
    S.objectUrl = URL.createObjectURL(file);
    video.src = S.objectUrl;
    S.lastMeta = null;
    try {
      await once(video, "loadedmetadata", 10000);
    } catch (e) {
      $("loadMsg").innerHTML = `<b style="color:var(--bad)">이 기기에서 재생할 수 없는 영상이에요.</b> ` +
        "카메라 설정의 포맷을 <b>높은 호환성</b>으로 바꿔 다시 찍어 주세요.";
      return;
    }
    // iOS는 한 번 재생해야 프레임을 그리는 경우가 있다
    try { await video.play(); } catch (_) {}
    video.pause();

    Object.assign(S, {
      file, source, info, frames: info.frames, index: 0,
      vw: video.videoWidth, vh: video.videoHeight,
      scalePts: [], scaleFrame: null, plan: [], points: [], fixRow: null, seekWarn: false,
    });
    S.warnings = checkVideo(info);
    $("stage").style.setProperty("--ar", (S.vw / S.vh).toFixed(4));
    $("slider").max = S.frames.length - 1;
    $("fileLabel").textContent = `${source} · ${info.fps ? info.fps.toFixed(0) : "?"} fps · ${S.vw}×${S.vh}`;
    $("loadMsg").textContent = "";

    if (!restore()) {
      setStep("scale");
      await showFrame(0);
    }
  }

  function checkVideo(info) {
    const w = [];
    if (S.vh > S.vw) w.push(["세로로 찍힌 영상이에요.", "공이 작게 보여 찍기 어려울 수 있어요. 가능하면 가로로 다시 찍어 주세요."]);
    if (info.fps && (info.fps < 50 || info.fps > 70)) w.push([`60fps가 아닌 영상이에요 (${info.fps.toFixed(0)} fps).`, "카메라 설정을 60fps로 바꿔 다시 찍으면 더 정확해요."]);
    if (Math.min(S.vw, S.vh) < 720) w.push(["영상 해상도가 낮아요.", "사진 보관함에서 고를 때 압축되었을 수 있어요. 파일 앱에서 골라 보세요."]);
    return w;
  }

  // ---------------------------------------------------------------- 저장·복원
  function storeKey() {
    return S.file ? STORE_PREFIX + S.file.name + ":" + S.file.size + ":" + S.frames.length : null;
  }

  function save() {
    const k = storeKey();
    if (!k) return;
    try {
      localStorage.setItem(k, JSON.stringify({ scalePts: S.scalePts, scaleFrame: S.scaleFrame, plan: S.plan, points: S.points, savedAt: Date.now() }));
    } catch (_) {}
  }

  function restore() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(storeKey()) || "null"); } catch (_) {}
    if (!d || (!d.scalePts.length && !d.points.length)) return false;
    const box = $("banners");
    setStep("scale");
    showFrame(d.scaleFrame || 0);
    box.innerHTML = `<div class="banner"><b>이전에 하던 작업이 있어요.</b> 이어서 할까요?
      <div class="row" style="margin-top:8px"><button class="primary" id="bResume">이어서 하기</button><button id="bFresh">새로 하기</button></div></div>`;
    $("bResume").onclick = () => {
      Object.assign(S, { scalePts: d.scalePts, scaleFrame: d.scaleFrame, plan: d.plan || [], points: d.points || [] });
      if (S.scalePts.length === 3 && S.points.length >= MIN_POINTS) setStep("table");
      else if (S.scalePts.length === 3) { setStep("track"); showFrame(S.points.length ? trackFrame() : S.scaleFrame || 0); }
      else setStep("scale");
    };
    $("bFresh").onclick = () => { try { localStorage.removeItem(storeKey()); } catch (_) {} setStep("scale"); };
    return true;
  }

  // ---------------------------------------------------------------- 프레임 이동
  function nearestIndex(t) {
    const f = S.frames;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (f[m] < t) lo = m + 1; else hi = m;
    }
    if (lo > 0 && Math.abs(f[lo - 1] - t) < Math.abs(f[lo] - t)) lo--;
    return lo;
  }

  function midTime(i) {
    const f = S.frames;
    const next = i + 1 < f.length ? f[i + 1] : f[i] + (S.info.deltaStats.mean || 1 / 60);
    return (f[i] + next) / 2;
  }

  // 시각을 바꾸고 새 프레임이 실제로 그려질 때까지 기다린다 (0단계에서 검증한 방식)
  function rawSeek(t) {
    return new Promise((resolve) => {
      let meta = null, seeked = false, done = false, rvfcId = null, grace = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hard);
        clearTimeout(grace);
        video.removeEventListener("seeked", onSeeked);
        if (rvfcId !== null && !meta) video.cancelVideoFrameCallback(rvfcId);
        if (meta) S.lastMeta = meta;
        resolve(meta || (seeked ? S.lastMeta : null));
      };
      if (hasRVFC) rvfcId = video.requestVideoFrameCallback((now, m) => { meta = m; if (seeked) finish(); });
      const onSeeked = () => {
        seeked = true;
        if (!hasRVFC || meta) finish();
        else grace = setTimeout(finish, 250);
      };
      video.addEventListener("seeked", onSeeked);
      const hard = setTimeout(finish, 4000);
      video.currentTime = Math.max(0, t);
    });
  }

  async function showFrame(i) {
    i = clamp(Math.round(i), 0, S.frames.length - 1);
    if (S.busy) { S.pending = i; return; }
    S.busy = true;
    S.index = i;
    let meta = await rawSeek(midTime(i));
    // 실제로 그려진 프레임이 다르면 한 번 더 시도 (아이패드 대비 안전장치)
    if (meta && nearestIndex(meta.mediaTime) !== i) {
      meta = await rawSeek(S.frames[i] + 0.001);
      S.seekWarn = !!meta && nearestIndex(meta.mediaTime) !== i;
    }
    S.busy = false;
    if (S.pending !== null) {
      const p = S.pending;
      S.pending = null;
      return showFrame(p);
    }
    render();
  }

  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => showFrame(S.index + Number(b.dataset.nav)))
  );
  let sliderTimer = null;
  $("slider").addEventListener("input", (e) => {
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => showFrame(Number(e.target.value)), 50);
  });
  document.addEventListener("keydown", (e) => {
    if (S.step !== "scale" && !(S.step === "track" && !S.points.length && S.fixRow === null)) return;
    if (e.key === "ArrowRight") { showFrame(S.index + (e.shiftKey ? 10 : 1)); e.preventDefault(); }
    if (e.key === "ArrowLeft") { showFrame(S.index - (e.shiftKey ? 10 : 1)); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- 단계 전환
  document.querySelectorAll("#stepper [data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = b.dataset.step;
      if (!canEnter(s)) return;
      setStep(s);
      if (s === "scale") showFrame(S.scaleFrame ?? S.index);
      if (s === "track") showFrame(trackFrame());
    })
  );

  // ③ 단계로 들어갈 때 보여줄 프레임: 이어서 찍을 프레임, 다 찍었으면 마지막 점
  function trackFrame() {
    if (!S.points.length) return S.index;
    const next = S.plan[S.points.length];
    return next !== undefined && S.points.length < MAX_POINTS ? next : S.points[S.points.length - 1].frame;
  }

  function canEnter(s) {
    if (s === "load") return true;
    if (!S.file) return false;
    if (s === "scale") return true;
    if (s === "track") return S.scalePts.length === 3;
    if (s === "table") return S.scalePts.length === 3 && S.points.length >= MIN_POINTS;
    return false;
  }

  function setStep(s) {
    S.step = s;
    if (s !== "track") S.fixRow = null;
    $("banners").innerHTML = "";
    render();
  }

  // ---------------------------------------------------------------- 화면 그리기
  function render() {
    // 단계 표시
    document.querySelectorAll("#stepper [data-step]").forEach((b) => {
      const s = b.dataset.step;
      b.classList.toggle("active", s === S.step);
      b.disabled = !canEnter(s);
      const done = (s === "load" && S.file) || (s === "scale" && S.scalePts.length === 3) ||
        (s === "track" && S.points.length >= MIN_POINTS);
      b.classList.toggle("done", !!done && s !== S.step);
    });
    $("panelLoad").classList.toggle("hidden", S.step !== "load");
    $("panelWork").classList.toggle("hidden", S.step !== "scale" && S.step !== "track");
    $("panelTable").classList.toggle("hidden", S.step !== "table");

    if (S.step === "scale" || S.step === "track") renderWork();
    if (S.step === "table") renderTable();
  }

  function renderWork() {
    const banners = $("banners");
    if (!banners.innerHTML && S.step === "scale" && S.warnings.length) {
      banners.innerHTML = S.warnings.map(([a, b]) => `<div class="banner"><b>${esc(a)}</b> ${esc(b)}</div>`).join("");
    }

    const freeNav = S.step === "scale" || (S.step === "track" && S.points.length === 0 && S.fixRow === null);
    $("navBox").classList.toggle("hidden", !freeNav);
    $("slider").value = S.index;

    const actions = $("workActions");
    const status = [];
    let instr = "", sub = "";

    if (S.step === "scale") {
      const n = S.scalePts.length;
      if (n < 3) {
        instr = `기준판 과녁 ${["①", "②", "③"][n]}의 한가운데를 찍으세요`;
        sub = n === 0
          ? "기준판이 잘 보이는 프레임을 찾은 뒤, 과녁을 ① → ② → ③ 순서로 찍습니다. 펜이나 손가락으로 누른 채 움직여 위치를 맞추고 떼면 확정됩니다."
          : "같은 프레임에서 이어서 찍습니다.";
        actions.innerHTML = n ? '<button id="aUndo">↶ 되돌리기</button>' : "";
      } else {
        const sc = scaleInfo();
        instr = `기준판 확인: 1 m = ${sc.pxPerM.toFixed(0)} px`;
        sub = sc.diff > TILT_WARN
          ? `⚠ 가로·세로 길이 비율이 ${(sc.diff * 100).toFixed(1)}% 어긋나요. 기준판이 카메라 쪽으로 기울었을 수 있어요. 다른 프레임에서 다시 찍어 보세요.`
          : `가로·세로 차이 ${(sc.diff * 100).toFixed(1)}% — 좋아요.`;
        actions.innerHTML = '<button id="aRedo">다시 찍기</button><button class="primary" id="aNext">다음: 공 찍기 →</button>';
      }
    } else if (S.fixRow !== null) {
      instr = `${S.fixRow + 1}번 점을 다시 찍으세요`;
      sub = "공 한가운데를 찍으면 데이터 표로 돌아갑니다.";
      actions.innerHTML = '<button id="aCancelFix">취소</button>';
    } else if (S.points.length === 0) {
      instr = "공이 손을 떠난 순간의 프레임을 찾아 공을 찍으세요";
      sub = "이 점이 원점 (0, 0)이 됩니다. 그다음부터는 0.05초씩 자동으로 넘어갑니다.";
      actions.innerHTML = "";
    } else if (S.points.length >= MAX_POINTS || S.plan[S.points.length] === undefined) {
      instr = "공을 모두 찍었어요";
      sub = S.points.length >= MAX_POINTS ? `최대 ${MAX_POINTS}개까지 찍었습니다.` : "영상이 끝나 더 찍을 프레임이 없습니다.";
      actions.innerHTML = '<button id="aUndo">↶ 되돌리기</button><button class="primary" id="aDone">표 보기</button>';
      status.push(`<span class="pill">${S.points.length} / ${MAX_POINTS}점</span>`);
    } else {
      const k = S.points.length;
      instr = `${k + 1}번째 점: 공 한가운데를 찍으세요`;
      sub = k >= MIN_POINTS ? "공이 땅에 닿았거나 화면을 벗어났으면 '끝'을 누르세요." : `최소 ${MIN_POINTS}개를 찍어야 합니다.`;
      actions.innerHTML = `<button id="aUndo">↶ 되돌리기</button><button class="primary" id="aDone" ${k >= MIN_POINTS ? "" : "disabled"}>끝 · 표 보기</button>`;
      status.push(`<span class="pill">t = ${f2(k * STEP_DT)} s</span>`, `<span class="pill">${k} / ${MAX_POINTS}점</span>`);
    }

    status.unshift(`<span class="pill">프레임 ${S.index} / ${S.frames.length - 1}</span>`);
    if (S.seekWarn) status.push('<span class="pill warn">⚠ 프레임 이동 확인 필요</span>');
    $("status").innerHTML = status.join("");
    $("instr").textContent = instr;
    $("instrSub").textContent = sub;

    bindActions();
    drawOverlay();
  }

  function bindActions() {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on("aUndo", () => {
      if (S.step === "scale") S.scalePts.pop();
      else if (S.points.length) {
        const p = S.points.pop();
        save();
        return showFrame(p.frame);
      }
      save();
      render();
    });
    on("aRedo", () => { S.scalePts = []; save(); render(); });
    on("aNext", () => { setStep("track"); showFrame(trackFrame()); });
    on("aDone", () => setStep("table"));
    on("aCancelFix", () => setStep("table"));
  }

  function scaleInfo() {
    const [p1, p2, p3] = S.scalePts;
    const sx = dist(p1, p2) / BOARD_D12;
    const sy = dist(p1, p3) / BOARD_D13;
    const pxPerM = (sx + sy) / 2;
    return { sx, sy, pxPerM, diff: Math.abs(sx - sy) / pxPerM };
  }

  // ---------------------------------------------------------------- 좌표 변환
  // 영상이 무대 안에 꽉 차지 않을 때(가로세로 비율 차이)도 맞도록 contain 배치를 계산
  function layout() {
    const r = overlay.getBoundingClientRect();
    const sc = Math.min(r.width / S.vw, r.height / S.vh);
    return { r, sc, ox: (r.width - S.vw * sc) / 2, oy: (r.height - S.vh * sc) / 2 };
  }

  function clientToVideo(cx, cy) {
    const L = layout();
    return {
      x: clamp((cx - L.r.left - L.ox) / L.sc, 0, S.vw),
      y: clamp((cy - L.r.top - L.oy) / L.sc, 0, S.vh),
    };
  }

  function sizeOverlay() {
    const r = overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    return dpr;
  }

  // ---------------------------------------------------------------- 겹쳐 그리기
  function drawOverlay() {
    if (!S.vw) return;
    const dpr = sizeOverlay();
    const L = layout();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    // 영상 픽셀 → 캔버스 픽셀
    octx.setTransform(L.sc * dpr, 0, 0, L.sc * dpr, L.ox * dpr, L.oy * dpr);
    const u = 1 / L.sc; // 화면 1 css px에 해당하는 영상 픽셀

    if (S.step === "scale") {
      const pts = S.scalePts;
      if (pts.length >= 2) line(pts[0], pts[1], u);
      if (pts.length >= 3) line(pts[0], pts[2], u);
      pts.forEach((p, k) => marker(p, String(k + 1), "#ff3b30", u));
    } else {
      S.points.forEach((p, k) => {
        if (S.fixRow === k) return;
        const onFrame = p.frame === S.index;
        dot(p, onFrame ? "#ff3b30" : "rgba(255,59,48,.55)", u, k === 0 ? "0" : "");
      });
    }
    if (S.drag) crosshair(S.drag.pos, u);
  }

  function line(a, b, u) {
    octx.strokeStyle = "rgba(255,59,48,.8)";
    octx.lineWidth = 2 * u;
    octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  }

  function marker(p, label, color, u) {
    octx.strokeStyle = color;
    octx.lineWidth = 2 * u;
    octx.beginPath(); octx.arc(p.x, p.y, 9 * u, 0, Math.PI * 2); octx.stroke();
    octx.beginPath(); octx.moveTo(p.x - 14 * u, p.y); octx.lineTo(p.x + 14 * u, p.y); octx.moveTo(p.x, p.y - 14 * u); octx.lineTo(p.x, p.y + 14 * u); octx.stroke();
    octx.fillStyle = color;
    octx.font = `bold ${16 * u}px sans-serif`;
    octx.fillText(label, p.x + 12 * u, p.y - 12 * u);
  }

  function dot(p, color, u, label) {
    octx.fillStyle = color;
    octx.beginPath(); octx.arc(p.x, p.y, 4 * u, 0, Math.PI * 2); octx.fill();
    if (label) {
      octx.font = `bold ${14 * u}px sans-serif`;
      octx.fillText(label, p.x + 8 * u, p.y - 8 * u);
    }
  }

  function crosshair(p, u) {
    octx.strokeStyle = "#00e5ff";
    octx.lineWidth = 1.5 * u;
    octx.beginPath();
    octx.moveTo(p.x - 22 * u, p.y); octx.lineTo(p.x - 5 * u, p.y);
    octx.moveTo(p.x + 5 * u, p.y); octx.lineTo(p.x + 22 * u, p.y);
    octx.moveTo(p.x, p.y - 22 * u); octx.lineTo(p.x, p.y - 5 * u);
    octx.moveTo(p.x, p.y + 5 * u); octx.lineTo(p.x, p.y + 22 * u);
    octx.stroke();
  }

  // ---------------------------------------------------------------- 돋보기
  function drawLoupe(e, pos) {
    const size = 150;
    const L = layout();
    // 손가락 위쪽에 띄우되, 화면 위로 넘치면 옆으로
    let left = e.clientX - size / 2, top = e.clientY - size - 40;
    if (top < 8) { top = clamp(e.clientY - size / 2, 8, window.innerHeight - size - 8); left = e.clientX + 50; if (left + size > window.innerWidth - 8) left = e.clientX - 50 - size; }
    loupe.style.left = clamp(left, 8, window.innerWidth - size - 8) + "px";
    loupe.style.top = top + "px";
    loupe.classList.remove("hidden");

    const W = loupe.width;
    const srcSize = size / (L.sc * LOUPE_ZOOM); // 영상 픽셀
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.fillStyle = "#000";
    lctx.fillRect(0, 0, W, W);
    const k = W / srcSize;
    const sx0 = pos.x - srcSize / 2, sy0 = pos.y - srcSize / 2;
    const ix0 = Math.max(0, sx0), iy0 = Math.max(0, sy0);
    const ix1 = Math.min(S.vw, sx0 + srcSize), iy1 = Math.min(S.vh, sy0 + srcSize);
    if (ix1 > ix0 && iy1 > iy0) {
      try {
        lctx.imageSmoothingEnabled = false;
        lctx.drawImage(video, ix0, iy0, ix1 - ix0, iy1 - iy0, (ix0 - sx0) * k, (iy0 - sy0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k);
      } catch (_) {}
    }
    // 이전 점
    lctx.fillStyle = "rgba(255,59,48,.8)";
    const pts = S.step === "scale" ? S.scalePts : S.points.filter((p, i) => S.fixRow !== i);
    pts.forEach((p) => {
      const x = (p.x - pos.x) * k + W / 2, y = (p.y - pos.y) * k + W / 2;
      if (x > -10 && x < W + 10 && y > -10 && y < W + 10) { lctx.beginPath(); lctx.arc(x, y, 5, 0, Math.PI * 2); lctx.fill(); }
    });
    // 십자선
    lctx.strokeStyle = "#00e5ff";
    lctx.lineWidth = 2;
    const c = W / 2;
    lctx.beginPath();
    lctx.moveTo(0, c); lctx.lineTo(c - 10, c); lctx.moveTo(c + 10, c); lctx.lineTo(W, c);
    lctx.moveTo(c, 0); lctx.lineTo(c, c - 10); lctx.moveTo(c, c + 10); lctx.lineTo(c, W);
    lctx.stroke();
  }

  // ---------------------------------------------------------------- 찍기 입력
  function acceptsTap() {
    if (S.busy) return false;
    if (S.step === "scale") return S.scalePts.length < 3;
    if (S.step === "track") {
      if (S.fixRow !== null || !S.points.length) return true;
      const next = S.plan[S.points.length];
      return S.points.length < MAX_POINTS && next !== undefined && S.index === next;
    }
    return false;
  }

  overlay.addEventListener("pointerdown", (e) => {
    if (!acceptsTap() || S.drag) return;
    if (e.pointerType === "touch" && performance.now() < S.penUntil) return; // 손바닥
    e.preventDefault();
    try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
    S.drag = { id: e.pointerId, type: e.pointerType, pos: clientToVideo(e.clientX, e.clientY) };
    moveDrag(e);
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!S.drag || e.pointerId !== S.drag.id) return;
    e.preventDefault();
    moveDrag(e);
  });

  overlay.addEventListener("pointerup", (e) => {
    if (!S.drag || e.pointerId !== S.drag.id) return;
    const { pos, type } = S.drag;
    S.drag = null;
    loupe.classList.add("hidden");
    if (type === "pen") S.penUntil = performance.now() + 600;
    commit(pos);
  });

  overlay.addEventListener("pointercancel", (e) => {
    if (!S.drag || e.pointerId !== S.drag.id) return;
    S.drag = null;
    loupe.classList.add("hidden");
    drawOverlay();
  });

  function moveDrag(e) {
    S.drag.pos = clientToVideo(e.clientX, e.clientY);
    if (S.drag.type === "touch") drawLoupe(e, S.drag.pos);
    if (S.drag.type === "pen") S.penUntil = performance.now() + 600;
    drawOverlay();
  }

  function commit(pos) {
    if (S.step === "scale") {
      if (!S.scalePts.length) S.scaleFrame = S.index;
      S.scalePts.push(pos);
      save();
      return render();
    }
    if (S.step !== "track") return;

    if (S.fixRow !== null) {
      S.points[S.fixRow] = { frame: S.index, x: pos.x, y: pos.y };
      S.fixRow = null;
      save();
      return setStep("table");
    }

    if (!S.points.length) {
      S.plan = Mp4Meta.pickByStep(S.frames, S.index, STEP_DT, MAX_POINTS);
    }
    S.points.push({ frame: S.index, x: pos.x, y: pos.y });
    save();
    const next = S.plan[S.points.length];
    if (S.points.length >= MAX_POINTS || next === undefined) {
      return setStep("table");
    }
    render();
    showFrame(next);
  }

  // ---------------------------------------------------------------- 데이터 표
  function rows() {
    const { pxPerM } = scaleInfo();
    const o = S.points[0];
    return S.points.map((p, k) => ({
      n: k + 1,
      t: k * STEP_DT,
      x: (p.x - o.x) / pxPerM,
      y: -(p.y - o.y) / pxPerM,
    }));
  }

  function renderTable() {
    const R = rows();
    const N = R.length;
    let iB = 0;
    R.forEach((r, k) => { if (r.y > R[iB].y) iB = k; });
    const iA = 1, iC = N - 2;
    const tagOf = (k) => (k === iB ? "B" : k === iA ? "A" : k === iC ? "C" : "");

    const warns = [];
    if (iB >= N - 2) warns.push("최고점 뒤에 찍힌 점이 부족해요. 공이 떨어지는 장면까지 찍어야 C를 정할 수 있어요. 위의 ③ 공 찍기를 눌러 이어서 찍어 주세요.");
    if (iB <= 1) warns.push("최고점이 너무 앞쪽이에요. 공을 위로 비스듬히 던졌는지, 첫 점을 공이 손을 떠난 순간에 찍었는지 확인해 주세요.");
    $("tableBanners").innerHTML = warns.map((w) => `<div class="banner"><b>확인해 주세요.</b> ${esc(w)}</div>`).join("");

    const sc = scaleInfo();
    $("tableSub").textContent = `시간 간격 Δt = ${STEP_DT} s · 원점은 1번 점 · 위쪽이 + · 1 m = ${sc.pxPerM.toFixed(0)} px`;
    $("dataTable").innerHTML =
      "<thead><tr><th></th><th>번호</th><th>t (s)</th><th>x (m)</th><th>y (m)</th></tr></thead><tbody>" +
      R.map((r, k) => {
        const tg = tagOf(k);
        return `<tr class="pt ${tg}" data-row="${k}"><td>${tg ? `<span class="tag ${tg}">${tg}</span>` : ""}</td>` +
          `<td>${r.n}</td><td>${f2(r.t)}</td><td>${f2(r.x)}</td><td>${f2(r.y)}</td></tr>`;
      }).join("") + "</tbody>";

    document.querySelectorAll("#dataTable tr.pt").forEach((tr) =>
      tr.addEventListener("click", () => {
        const k = Number(tr.dataset.row);
        if (k === 0) {
          if (!confirm("1번 점은 원점이라, 다시 찍으면 모든 점의 값이 바뀝니다. 다시 찍을까요?")) return;
        }
        S.fixRow = k;
        S.step = "track";
        $("banners").innerHTML = "";
        render();
        showFrame(S.points[k].frame);
      })
    );
  }

  $("btnRetrack").addEventListener("click", () => {
    if (!confirm("찍은 공 위치를 모두 지우고 다시 찍을까요? (기준판은 그대로 둡니다)")) return;
    const first = S.points.length ? S.points[0].frame : S.index;
    S.points = [];
    S.plan = [];
    save();
    setStep("track");
    showFrame(first);
  });

  $("btnRestart").addEventListener("click", () => {
    if (!confirm("기준판과 공 위치를 모두 지우고 처음부터 할까요?")) return;
    try { localStorage.removeItem(storeKey()); } catch (_) {}
    S.scalePts = []; S.points = []; S.plan = [];
    setStep("load");
  });

  window.addEventListener("resize", () => { if (S.step === "scale" || S.step === "track") drawOverlay(); });

  // 테스트·디버깅용 (콘솔에서 상태 확인)
  window.__pt = { S, rows, scaleInfo, clientToVideo, layout };

  render();
})();
