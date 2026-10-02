#!/usr/bin/env python3
"""Work out where a marker may sit on each hero-tree painting.

Run it whenever `src/assets/hero-*.webp` changes:

    python3 -m venv .venv && .venv/bin/pip install pillow numpy scipy
    .venv/bin/python scripts/generate-hero-tree-markers.py

It rewrites `src/features/domains/heroTreeSpots.ts`. That file is generated -
edit this script, never the output.

Two pools come out of each painting, and the component adds a third:

  foliage  leaves. Fruit, butterflies, bees and ladybugs go here.
  bark     trunk and thick limbs. Snails go here.
  (ground) below the artwork, so the component places those itself.

How the pools are built, and why each step is the way it is:

  1. Leaves are green-dominant (G >= R) and bark is not, so a channel comparison
     separates them exactly; a hue window does not, because the trunk's
     highlights sit in the same yellow-green band as the sunlit leaves.
  2. Each mask is eroded by a margin (distance transform). Without it,
     farthest-point sampling parks almost every marker on the silhouette and
     several hang off the tree - measured, not guessed. Bark is eroded harder so
     thin twigs drop out: a snail on a twig reads as a mistake, and foliage
     additionally has to clear the bark so fruit never hangs on the trunk.
  3. Points come out as ONE ordered farthest-point sequence per pool, seeded at
     the deepest point of the mask. Farthest-point sampling has the property that
     the first k points are themselves a good spread for k, so a single list
     serves every domain count.
  4. `spacing[k-1]` is the closest two of the first k foliage points ever get.
     The component sizes markers from it, so they shrink as domains are added
     instead of piling up.

Coordinates are normalised to 0-1000 of each painting's own box, so the component
can place them whatever size it draws that stage at.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'src' / 'assets'
OUT = ROOT / 'src' / 'features' / 'domains' / 'heroTreeSpots.ts'

ALPHA_MIN = 120
# How many markers each stage can ever need. A stage is chosen by domain count
# (1-2 sprout, 3-5 sapling, 6+ tree), so only the tree ever fills up.
STAGE_MAX = {'sprout': 2, 'sapling': 5, 'tree': 40}
# At most this many snails; the bark of a young plant barely exists.
BARK_MAX = 12
# Keep a marker this far inside its mask, as a fraction of the image width.
# Sized against the component's largest marker: one centred on a kept point then
# overhangs by a few pixels at worst, which reads as sitting at the edge rather
# than floating off it. Bark gets more so that thin twigs drop out entirely.
EDGE_MARGIN = 0.045
BARK_MARGIN = 0.022
# Foliage points must also clear the trunk and branches by this much. The mask
# is "is this pixel green", and the canopy has green pixels right against the
# bark, so without this a bunch of fruit lands on the trunk - which is the one
# thing fruit must never do.
BARK_CLEARANCE = 0.028
# Relax the margin rather than lose the outer canopy entirely.
MIN_KEPT = 0.35
STAGES = {
    'sprout': 'hero-sprout.webp',
    'sapling': 'hero-sapling.webp',
    'tree': 'hero-tree.webp',
}


def masks(path):
    """(leaves, bark). Leaves are green-dominant; whatever else is solid is bark."""
    im = Image.open(path).convert('RGBA')
    alpha = np.array(im.getchannel('A'))
    rgb = np.array(im.convert('RGB')).astype(np.int16)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    solid = alpha > ALPHA_MIN
    leaves = solid & (g >= r) & (g - b > 18)
    return leaves, solid & ~leaves, im.size


def inner_mask(mask, width, fraction):
    """Erode the mask so a marker centred on a point still sits on the tree."""
    dist = distance_transform_edt(mask)
    margin = width * fraction
    while margin > 2:
        inner = dist >= margin
        if inner.sum() >= mask.sum() * MIN_KEPT:
            return inner, margin
        margin *= 0.75
    return mask, 0.0


def scatter(mask, width, count, margin, avoid=None):
    """Ordered farthest-point sequence, seeded at the deepest point of the mask."""
    dist = distance_transform_edt(mask)
    inner, _ = inner_mask(mask, width, margin)
    if avoid is not None:
        clear = distance_transform_edt(~avoid) >= width * BARK_CLEARANCE
        # Relax rather than run out of room: branches thread through the whole
        # canopy, so a strict clearance can leave almost nothing.
        while (inner & clear).sum() < inner.sum() * 0.25:
            clear = distance_transform_edt(~avoid) >= width * BARK_CLEARANCE * 0.6
            break
        inner = inner & clear
    ys, xs = np.nonzero(inner)
    pts = np.column_stack([xs, ys]).astype(np.float64)
    # Sampling every pixel is needless work at this resolution and changes
    # nothing about the result; the stride keeps it deterministic.
    stride = max(1, len(pts) // 40000)
    pts = pts[::stride]
    depth = dist[ys, xs][::stride]

    first = int(np.argmax(depth))
    picked = [first]
    near = np.hypot(pts[:, 0] - pts[first, 0], pts[:, 1] - pts[first, 1])
    spacing = []
    for _ in range(min(count, len(pts)) - 1):
        i = int(np.argmax(near))
        spacing.append(float(near[i]))
        picked.append(i)
        near = np.minimum(near, np.hypot(pts[:, 0] - pts[i, 0], pts[:, 1] - pts[i, 1]))
    return pts[picked], spacing


def build():
    stages = {}
    for name, asset in STAGES.items():
        leaves, bark, (w, h) = masks(ASSETS / asset)
        points, spacing = scatter(leaves, w, STAGE_MAX[name], EDGE_MARGIN, avoid=bark)
        # A sprout's stem is barely there; an empty bark pool just means snails
        # fall back to the foliage, which the component already handles.
        bark_points = []
        if bark.sum() > leaves.sum() * 0.04:
            bark_points, _ = scatter(bark, w, BARK_MAX, BARK_MARGIN)
        stages[name] = {
            'foliage': [{'x': round(x / w * 1000), 'y': round(y / h * 1000)} for x, y in points],
            'bark': [{'x': round(x / w * 1000), 'y': round(y / h * 1000)} for x, y in bark_points],
            'spacing': [1000.0] + [round(d / w * 1000, 1) for d in spacing],
        }
        stages[name]['spacing'] = stages[name]['spacing'][:len(points)]
        print(f'{name}: foliage {len(points)}, bark {len(bark_points)}, '
              f'min spacing {stages[name]["spacing"][-1]:.0f}/1000')
    return stages


HEADER = '''/**
 * GENERATED FILE - do not edit.
 * Run `scripts/generate-hero-tree-markers.py` after changing `src/assets/hero-*.webp`.
 *
 * マーカーを置ける場所。段階ごとに順序付きの列で、先頭 N 個がそのまま N 件ぶんの
 * ちょうどよい散らばりになる。座標と間隔は絵の矩形に対する 0-1000 の正規化値。
 * 割り出し方は生成スクリプトの docstring に書いてある。
 */

export type HeroTreeSpot = {
  x: number
  y: number
}

export type HeroTreeSpots = {
  /** 葉のかたまり。実・ちょうちょ・はち・てんとう虫はここ。 */
  foliage: HeroTreeSpot[]
  /** 幹と太い枝。かたつむりはここ。芽のように幹が無い段階では空。 */
  bark: HeroTreeSpot[]
  /** spacing[k-1] = 先頭 k 個のうち、いちばん近い2つの間隔。大きさの決め手。 */
  spacing: number[]
}

/** 段階 id -> 置ける場所。 */
export const HERO_TREE_SPOTS: Record<string, HeroTreeSpots> =
'''


if __name__ == '__main__':
    data = build()
    body = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
    OUT.write_text(HEADER + '  ' + body + '\n', encoding='utf-8')
    print('wrote', OUT.relative_to(ROOT), f'({OUT.stat().st_size} bytes)')
