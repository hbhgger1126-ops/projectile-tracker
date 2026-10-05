"""연습용 예시 영상 생성기 (정답을 아는 합성 영상).

앞부분 0.8초 동안 A4 기준판(과녁 1→2 = 25.0 cm, 1→3 = 15.0 cm)이 공이 날아갈 면에 있고,
기준판이 빠진 뒤 테니스공을 비스듬히 던진다. 화면 배율은 PX_PER_M으로 고정.

사용법: python tools/make_sample_throw.py
출력:   samples/sample-throw.mp4, samples/sample-throw.json (정답값)
"""
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).parent.parent
OUT = ROOT / "samples" / "sample-throw.mp4"
W, H, FPS = 1920, 1080, 60.0
PX_PER_M = 450.0
SECONDS = 2.2
G = 9.8

FLOOR_PX = H - 90                    # 바닥(y = 0 m)의 화면 높이
BALL_R = 0.0335                      # m
BOARD_UNTIL = 0.8                    # s, 이때까지 기준판이 보임
HOLD_FROM, RELEASE = 1.0, 1.1        # s, 공이 손에 있다가 놓이는 시각
X0, Y0 = 0.60, 0.90                  # m, 놓는 순간 공 중심
VX, VY0 = 2.4, 3.2                   # m/s

# 기준판: A4 가로(297 × 210 mm), 왼쪽 아래 모서리 위치(m)
BOARD_X, BOARD_Y = 1.45, 0.95
TARGETS_MM = [(23.5, 30.0), (273.5, 30.0), (23.5, 180.0)]  # 판의 왼쪽 아래 기준 (가로, 위쪽)


def to_px(x_m, y_m):
    return x_m * PX_PER_M, FLOOR_PX - y_m * PX_PER_M


def ball_pos(t):
    if t < RELEASE:
        return X0, Y0
    tt = t - RELEASE
    y = Y0 + VY0 * tt - 0.5 * G * tt * tt
    x = X0 + VX * tt
    if y < BALL_R:
        return None  # 땅에 닿은 뒤는 그리지 않음
    return x, y


SS = 4  # 안티에일리어싱용 초과 표본 배율


def draw_circle(img, x, y, r, color, thickness=-1):
    cv2.circle(img, (int(round(x * SS)), int(round(y * SS))), int(round(r * SS)), color, thickness, cv2.LINE_AA, 2)


def background():
    img = np.zeros((H, W, 3), np.uint8)
    for row in range(H):
        v = int(232 - 18 * row / H)
        img[row, :] = (v, v + 2, v + 4)
    cv2.rectangle(img, (0, FLOOR_PX), (W, H), (170, 175, 180), -1)
    cv2.line(img, (0, FLOOR_PX), (W, FLOOR_PX), (120, 125, 130), 2)
    return img


def draw_board(img):
    bx, by = to_px(BOARD_X, BOARD_Y)
    bw, bh = 0.297 * PX_PER_M, 0.210 * PX_PER_M
    cv2.rectangle(img, (int(bx), int(by - bh)), (int(bx + bw), int(by)), (252, 252, 252), -1)
    cv2.rectangle(img, (int(bx), int(by - bh)), (int(bx + bw), int(by)), (150, 150, 150), 1)
    # 손 (판을 든 사람)
    cv2.rectangle(img, (int(bx + bw * 0.45), int(by)), (int(bx + bw * 0.55), FLOOR_PX), (90, 110, 140), -1)
    centers = []
    for k, (mx, my) in enumerate(TARGETS_MM, start=1):
        cx, cy = bx + mx / 1000 * PX_PER_M, by - my / 1000 * PX_PER_M
        centers.append((cx, cy))
        for r_mm, col in ((10, (20, 20, 20)), (6.5, (255, 255, 255)), (3.5, (20, 20, 20))):
            r = r_mm / 1000 * PX_PER_M
            cv2.circle(img, (int(round(cx * SS)), int(round(cy * SS))), int(round(r * SS)), col, -1, cv2.LINE_AA, 2)
        cv2.putText(img, str(k), (int(cx + 8), int(cy - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 20, 20), 2, cv2.LINE_AA)
    return centers


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    writer = None
    for fourcc in ("avc1", "H264"):
        w = cv2.VideoWriter(str(OUT), cv2.VideoWriter_fourcc(*fourcc), FPS, (W, H))
        if w.isOpened():
            writer = w
            break
    if writer is None:
        raise SystemExit("H.264 VideoWriter를 열 수 없음")

    bg = background()
    n = int(round(FPS * SECONDS))
    board_centers = None
    truth_frames = []
    for i in range(n):
        t = i / FPS
        img = bg.copy()
        if t < BOARD_UNTIL:
            board_centers = draw_board(img)
        if t >= HOLD_FROM:
            p = ball_pos(t)
            if p:
                px, py = to_px(*p)
                r = BALL_R * PX_PER_M
                draw_circle(img, px, py, r, (60, 225, 225))
                draw_circle(img, px, py, r, (30, 140, 150), 1)
                truth_frames.append({"frame": i, "t": round(t, 6), "x_px": px, "y_px": py})
            if t < RELEASE:
                hx, hy = to_px(X0, Y0)
                cv2.rectangle(img, (int(hx - 30), int(hy + 12)), (int(hx + 6), FLOOR_PX), (90, 110, 140), -1)
        writer.write(img)
    writer.release()

    release_frame = int(round(RELEASE * FPS))
    truth = {
        "fps": FPS, "px_per_m": PX_PER_M, "g": G,
        "release_frame": release_frame,
        "x0_m": X0, "y0_m": Y0, "vx": VX, "vy0": VY0,
        "board_targets_px": board_centers,
        "ball_px": truth_frames,
    }
    (OUT.with_suffix(".json")).write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")
    print(OUT, f"{n} frames", "release frame", release_frame)


if __name__ == "__main__":
    main()
