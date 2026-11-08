/**
 * 逐行 diff3 三方合并（纯函数，无任何外部依赖，便于 node 直接单测）。
 * Line-based three-way merge (pure, dependency free).
 *
 * 规则 / Rules
 *  - 行以 "\n" 切分，行尾的 "\r" 属于行内容，因此 CRLF/LF 原样保留；"" 表示 0 行，末尾换行表现为最后一个空元素。
 *  - 仅一侧改动 → 取该侧；两侧做了相同改动 → 只保留一份。
 *  - 两侧改动的 base 行区间有交集且结果不同 → 冲突。区间仅相邻（不重叠）不算冲突。
 *  - 两侧在同一位置都是纯插入（不改不删 base 行）且内容不同 → 本地在前、远端在后保留双方，记入 notes，不算冲突。
 */

export type Diff3Result =
  | { ok: true; merged: string; notes: string[] }
  | { ok: false; conflicts: number; notes: string[] }

interface Hunk {
  aStart: number // base 区间 [aStart, aEnd)
  aEnd: number
  bStart: number // 该侧对应区间 [bStart, bEnd)
  bEnd: number
}

interface SideHunk extends Hunk {
  side: "L" | "R"
}

/** 差异过大时放弃精确 LCS，退化为一整块替换（只会增加冲突，不会丢内容） */
const MAX_EDIT_DISTANCE = 2000

export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n")
}

/** Myers O(ND) 行级 diff，返回 a→b 的修改块；超过上限返回 null */
function myers(a: number[], b: number[]): Hunk[] | null {
  const N = a.length
  const M = b.length
  const max = N + M
  const maxD = Math.min(max, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const V = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= maxD; d++) {
    // snapshot：V_{d-1}，覆盖 k ∈ [-d-1, d+1]，下标 j ↔ k = j - d - 1
    trace.push(V.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) x = V[offset + k + 1]
      else x = V[offset + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[x] === b[y]) {
        x++
        y++
      }
      V[offset + k] = x
      if (x >= N && y >= M) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) return null

  // 回溯：收集 edit（i=插入 b[y]，d=删除 a[x]），自后向前
  const edits: { t: "i" | "d"; x: number; y: number }[] = []
  let x = N
  let y = M
  for (let d = found; d > 0; d--) {
    const s = trace[d]
    const k = x - y
    const at = (kk: number) => s[kk + d + 1]
    let prevK: number
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1
    else prevK = k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
    }
    if (x === prevX) {
      edits.push({ t: "i", x: prevX, y: prevY }) // 插入 b[prevY]
    } else {
      edits.push({ t: "d", x: prevX, y: prevY }) // 删除 a[prevX]
    }
    x = prevX
    y = prevY
  }
  edits.reverse()

  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  let ax = 0
  let by = 0
  for (const e of edits) {
    if (cur && (e.x !== ax || e.y !== by)) {
      hunks.push(cur)
      cur = null
    }
    if (!cur) cur = { aStart: e.x, aEnd: e.x, bStart: e.y, bEnd: e.y }
    if (e.t === "d") {
      cur.aEnd = e.x + 1
      ax = e.x + 1
      by = e.y
    } else {
      cur.bEnd = e.y + 1
      ax = e.x
      by = e.y + 1
    }
  }
  if (cur) hunks.push(cur)
  return hunks
}

/** base(a) → side(b) 的修改块 */
function diffHunks(a: string[], b: string[]): Hunk[] {
  let pre = 0
  const minLen = Math.min(a.length, b.length)
  while (pre < minLen && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  if (am.length === 0 && bm.length === 0) return []
  if (am.length === 0 || bm.length === 0) {
    return [{ aStart: pre, aEnd: pre + am.length, bStart: pre, bEnd: pre + bm.length }]
  }
  const ids = new Map<string, number>()
  const intern = (s: string) => {
    let v = ids.get(s)
    if (v === undefined) {
      v = ids.size
      ids.set(s, v)
    }
    return v
  }
  const ai = am.map(intern)
  const bi = bm.map(intern)
  const hs = myers(ai, bi)
  if (hs === null) return [{ aStart: pre, aEnd: pre + am.length, bStart: pre, bEnd: pre + bm.length }]
  return hs.map((h) => ({ aStart: h.aStart + pre, aEnd: h.aEnd + pre, bStart: h.bStart + pre, bEnd: h.bEnd + pre }))
}

/** 把 side 的修改块应用到 base 区间 [lo,hi) 上，得到该侧在此区间的文本 */
function applyRegion(base: string[], sideLines: string[], hunks: SideHunk[], lo: number, hi: number): string[] {
  const out: string[] = []
  let i = lo
  for (const h of hunks) {
    for (; i < h.aStart; i++) out.push(base[i])
    for (let j = h.bStart; j < h.bEnd; j++) out.push(sideLines[j])
    i = h.aEnd
  }
  for (; i < hi; i++) out.push(base[i])
  return out
}

const sameLines = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i])
/** big 中是否含有连续的 small（small 非空） */
const containsRun = (big: string[], small: string[]) => {
  if (small.length === 0 || small.length > big.length) return false
  for (let i = 0; i + small.length <= big.length; i++) if (small.every((v, k) => big[i + k] === v)) return true
  return false
}

export function diff3Merge(local: string, base: string, remote: string): Diff3Result {
  if (local === remote) return { ok: true, merged: local, notes: [] }
  if (local === base) return { ok: true, merged: remote, notes: [] }
  if (remote === base) return { ok: true, merged: local, notes: [] }

  const B = splitLines(base)
  const L = splitLines(local)
  const R = splitLines(remote)
  const all: SideHunk[] = [
    ...diffHunks(B, L).map((h) => ({ ...h, side: "L" as const })),
    ...diffHunks(B, R).map((h) => ({ ...h, side: "R" as const })),
  ]
  all.sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd || (p.side === q.side ? 0 : p.side === "L" ? -1 : 1))

  // 分组：区间有交集的修改块归为一组；仅相邻不归组；同一点的两个纯插入归为一组
  interface Group {
    lo: number
    hi: number
    hunks: SideHunk[]
    insAtHi: boolean
  }
  const groups: Group[] = []
  for (const h of all) {
    const g = groups[groups.length - 1]
    const isIns = h.aStart === h.aEnd
    if (g && (h.aStart < g.hi || (h.aStart === g.hi && isIns && g.insAtHi))) {
      g.hunks.push(h)
      if (h.aEnd > g.hi) {
        g.hi = h.aEnd
        g.insAtHi = isIns
      } else if (h.aEnd === g.hi && isIns) g.insAtHi = true
    } else {
      groups.push({ lo: h.aStart, hi: h.aEnd, hunks: [h], insAtHi: isIns })
    }
  }

  const out: string[] = []
  const notes: string[] = []
  let conflicts = 0
  let i = 0
  for (const g of groups) {
    for (; i < g.lo; i++) out.push(B[i])
    const lh = g.hunks.filter((h) => h.side === "L")
    const rh = g.hunks.filter((h) => h.side === "R")
    if (rh.length === 0) {
      out.push(...applyRegion(B, L, lh, g.lo, g.hi))
    } else if (lh.length === 0) {
      out.push(...applyRegion(B, R, rh, g.lo, g.hi))
    } else {
      const lt = applyRegion(B, L, lh, g.lo, g.hi)
      const rt = applyRegion(B, R, rh, g.lo, g.hi)
      if (sameLines(lt, rt)) {
        out.push(...lt)
      } else if (g.hunks.every((h) => h.aStart === h.aEnd && h.aStart === g.lo)) {
        // 同一位置两侧纯插入且内容不同：本地在前、远端在后
        const lp = L.slice(lh[0].bStart, lh[0].bEnd)
        const rp = R.slice(rh[0].bStart, rh[0].bEnd)
        // 文件末尾（base 为空时）两侧各带一个末尾换行终止符：只保留最后一个，避免中间多出空行
        // 一侧插入块已完整包含另一侧的插入块（典型：对端已合并过我这份）→ 只保留较大的一份，避免重复追加、两端互相重合并
        if (containsRun(rp, lp)) { out.push(...rp); notes.push(`第 ${g.lo + 1} 行位置远端插入已包含本地插入，保留一份`); i = g.hi; continue }
        if (containsRun(lp, rp)) { out.push(...lp); notes.push(`第 ${g.lo + 1} 行位置本地插入已包含远端插入，保留一份`); i = g.hi; continue }
        if (g.lo === B.length && lp.length > 0 && lp[lp.length - 1] === "" && rp.length > 0 && rp[rp.length - 1] === "") lp.pop()
        out.push(...lp, ...rp)
        notes.push(`两侧在第 ${g.lo + 1} 行位置各自插入了不同内容，已保留双方（本地在前、远端在后）`)
      } else {
        conflicts++
        // 冲突时输出占位（调用方不会使用 merged）
        out.push(...lt)
      }
    }
    i = g.hi
  }
  if (conflicts > 0) return { ok: false, conflicts, notes }
  for (; i < B.length; i++) out.push(B[i])
  return { ok: true, merged: out.join("\n"), notes }
}
