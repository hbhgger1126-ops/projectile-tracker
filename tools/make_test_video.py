"""0단계 검증용 테스트 영상 생성기.

각 프레임에 프레임 번호와 시각을 크게 찍고, 테니스공 크기의 원이 포물선을 그리며 움직인다.
화면에 보이는 번호와 웹 페이지가 표시하는 프레임 번호가 같은지 눈으로 확인하는 용도.

사용법: python tools/make_test_video.py [출력경로] [fps] [초]
"""
import sys
from pathlib import Path

import cv2
import numpy as np

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "test-videos" / "frame-counter-60fps.mp4"
fps = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
W, H = 1280, 720
PX_PER_M = 300  # 화면 가로 약 4.3 m

out.parent.mkdir(parents=True, exist_ok=True)

writer = None
for fourcc in ("avc1", "H264", "mp4v"):
    w = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*fourcc), fps, (W, H))
    if w.isOpened():
        writer = w
        print("codec:", fourcc)
        break
if writer is None:
    sys.exit("VideoWriter를 열 수 없음")

n_frames = int(round(fps * seconds))
g = 9.8
vx, vy0 = 2.5, 3.5          # m/s
x0, y0 = 1.0, 0.6           # m, 바닥 기준
throw_start = 0.5           # s, 이전에는 공이 손에 있음

for i in range(n_frames):
    t = i / fps
    img = np.full((H, W, 3), 245, np.uint8)

    # 1 m 눈금 (바닥선)
    floor_y = H - 60
    cv2.line(img, (0, floor_y), (W, floor_y), (120, 120, 120), 2)
    for m in range(0, 5):
        px = int(m * PX_PER_M)
        cv2.line(img, (px, floor_y - 12), (px, floor_y + 12), (60, 60, 60), 2)
        cv2.putText(img, f"{m} m", (px + 4, floor_y + 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (60, 60, 60), 2)

    # 공 위치
    tt = max(0.0, t - throw_start)
    x = x0 + vx * tt
    y = y0 + vy0 * tt - 0.5 * g * tt * tt
    if y < 0.034:
        y = 0.034
    cx, cy = int(x * PX_PER_M), int(floor_y - y * PX_PER_M)
    r = int(0.0335 * PX_PER_M)
    cv2.circle(img, (cx, cy), r, (40, 220, 230), -1)
    cv2.circle(img, (cx, cy), r, (20, 120, 130), 1)

    # 프레임 번호와 시각
    cv2.putText(img, f"FRAME {i:04d}", (40, 110), cv2.FONT_HERSHEY_SIMPLEX, 3.0, (20, 20, 20), 8)
    cv2.putText(img, f"t = {t:.4f} s   ({fps:g} fps)", (44, 175), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 3)

    # 프레임마다 위치가 바뀌는 막대 (중복 프레임 감지용)
    bx = int((i % 60) / 60 * W)
    cv2.rectangle(img, (bx, 200), (bx + 20, 230), (200, 40, 40), -1)

    writer.write(img)

writer.release()
print(f"{out}  ({n_frames} frames, {fps} fps)")
