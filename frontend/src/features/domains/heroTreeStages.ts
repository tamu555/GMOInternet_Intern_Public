/**
 * ヒーローの木の成長段階（芽 / 若木 / 大樹）。
 *
 * 3枚の絵は同じ焼き込み（HSV 彩度 x0.58・明度ガンマ 0.92）を通してあるので、
 * 別々のイラスト3枚ではなく「同じ株を3つの時期に見た絵」として並ぶ。
 *
 * 座標系は3段階で共通。幅 960、地面の線 GROUND_Y、下端 VIEW_BOTTOM を固定し、
 * 変わるのは絵の大きさと viewBox の上端だけ — こうしておくと、段階が変わっても
 * 地面と土手はぴくりとも動かず、伸びたのは植物だけに見える。
 *
 * 樹冠をどう房に割るかは heroTreeRegions.ts（生成物）が持つ。あちらの座標も
 * 絵の矩形に対する比率なので、ここで絵の寸法を変えても房は枝からずれない。
 */
import sproutUrl from '@/assets/hero-sprout.webp'
import saplingUrl from '@/assets/hero-sapling.webp'
import treeUrl from '@/assets/hero-tree.webp'

/** 共通座標系の幅。 */
export const ART_WIDTH = 960
/** 幹が土に入る高さ。どの段階の絵もここで下端を揃える。 */
export const GROUND_Y = 1020
/** viewBox の下端。地面と土手を描く余白ぶん GROUND_Y より下にある。 */
export const VIEW_BOTTOM = 1104
/** 根元の中心。地面・土手・接地影はここを軸に置く。 */
export const TRUNK_CENTER_X = 505

export type HeroTreeStage = {
  id: 'sprout' | 'sapling' | 'tree'
  art: string
  /** 共通座標系での絵の幅。高さは元画像の縦横比から出す。 */
  width: number
  height: number
  /** viewBox の上端。小さい段階ほど下げて、空を切り落とす。 */
  viewTop: number
}

function stage(
  id: HeroTreeStage['id'],
  art: string,
  width: number,
  aspect: number,
  viewTop: number,
): HeroTreeStage {
  return { id, art, width, height: Math.round(width / aspect), viewTop }
}

/** 芽。子葉が2枚しかないので、房も2件まで。 */
const SPROUT = stage('sprout', sproutUrl, 580, 1.3883, 566)

/** 若木。房は5件まで。 */
const SAPLING = stage('sapling', saplingUrl, 700, 0.9335, 210)

/** 大樹。ログインしていないときの木もこれ。 */
const TREE = stage('tree', treeUrl, 960, 960 / 1020, 0)

/** ログインしていない / 0件 / 一覧が取れなかったときの木。房は付かない。 */
export const DEFAULT_STAGE = TREE

/**
 * 保有件数 → 成長段階。0件はここへ来ない（DEFAULT_STAGE に戻す）ので、いちばん
 * 下は1件から始まる。
 */
export function stageForCount(count: number): HeroTreeStage {
  if (count <= 2) return SPROUT
  if (count <= 5) return SAPLING
  return TREE
}

