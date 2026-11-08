/** 冲突备份文件名与忽略窗口引用计数（纯逻辑，无外部依赖，便于单测） */

/**
 * conflict-notes 下的文件名主干：去掉 .md、路径分隔符与 Windows/移动端文件系统不允许的字符，附路径 hash 防碰撞。
 * 所有读写冲突备份的地方必须经由它，保证文件名一致。
 */
export function conflictStem(normalizedPath: string, hash: (s: string) => string): string {
  return `${normalizedPath.replace(/\.md$/, "").replace(/[/\\:*?"<>|]/g, "_")}_${hash(normalizedPath)}`
}

/** 自己写盘期间的忽略标记引用计数：多次写盘重叠时，只有最后一个计时器到期才真正取消忽略 */
export class IgnoreRefs {
  private counts = new Map<string, number>()
  acquire(path: string): void {
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1)
  }
  /** 返回 true 表示已无其它持有者，可以取消忽略 */
  release(path: string): boolean {
    const n = (this.counts.get(path) ?? 1) - 1
    if (n <= 0) {
      this.counts.delete(path)
      return true
    }
    this.counts.set(path, n)
    return false
  }
}
