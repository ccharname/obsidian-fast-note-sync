// 轻量行级 diff：供冲突合并弹窗对比"原文件"与"冲突副本"内容，
// 输出格式与 note-history 的 diffs 字段（{ Type, Text }）保持一致，方便直接复用 HistoryDetail 渲染。
// Lightweight line-level diff for the conflict resolve modal to compare the original file against
// the conflict copy. Output shape ({ Type, Text }) matches note-history's diffs field so it can be
// fed straight into HistoryDetail's rendering.

export interface LineDiff {
  Type: number; // 1 = 新增（仅存在于副本）, -1 = 删除（仅存在于原文件）, 0 = 未变化
  Text: string;
}

// 行数乘积超过该阈值时跳过逐行对比（避免 O(n*m) 的 LCS 计算在超大笔记上卡死），
// 调用方应回退为并排展示原始内容。
// Skip line-by-line diffing once the product of line counts exceeds this guard (avoids the O(n*m)
// LCS blowing up on very large notes); callers should fall back to showing raw content side by side.
const MAX_DIFF_CELLS = 4_000_000;

export const canDiffLines = function (a: string, b: string): boolean {
  const n = a.split("\n").length;
  const m = b.split("\n").length;
  return n * m <= MAX_DIFF_CELLS;
};

/**
 * 对两段文本按行做最长公共子序列（LCS）diff
 * Diff two texts line-by-line using longest common subsequence (LCS)
 */
export const diffLines = function (original: string, updated: string): LineDiff[] {
  const a = original.split("\n");
  const b = updated.split("\n");
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type RunType = 'equal' | 'add' | 'delete';
  const runs: { type: RunType; line: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      runs.push({ type: 'equal', line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      runs.push({ type: 'delete', line: a[i] });
      i++;
    } else {
      runs.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) { runs.push({ type: 'delete', line: a[i] }); i++; }
  while (j < m) { runs.push({ type: 'add', line: b[j] }); j++; }

  // 将连续同类型行合并为一个 diff 块，行间以 \n 拼接
  // Merge consecutive same-type lines into a single diff chunk, joined by \n
  const chunks: { type: RunType; lines: string[] }[] = [];
  let bucket: { type: RunType; lines: string[] } | null = null;
  for (const run of runs) {
    if (bucket && bucket.type === run.type) {
      bucket.lines.push(run.line);
    } else {
      if (bucket) chunks.push(bucket);
      bucket = { type: run.type, lines: [run.line] };
    }
  }
  if (bucket) chunks.push(bucket);

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const Type = chunk.type === 'add' ? 1 : chunk.type === 'delete' ? -1 : 0;
    const Text = isLast ? chunk.lines.join("\n") : chunk.lines.join("\n") + "\n";
    return { Type, Text };
  });
};
