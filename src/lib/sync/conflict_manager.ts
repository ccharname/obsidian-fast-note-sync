import { Notice } from "obsidian";

import { SyncLogManager } from "./sync_log_manager";
import { $ } from "../../i18n/lang";
import type FastSync from "../../main";

// 服务端冲突副本命名格式（conflict_service.go）：{baseName}.conflict.{timestamp}{ext}
// 例：notes/test.md -> notes/test.conflict.20060102150405.md
// Server-side conflict copy naming (conflict_service.go): {baseName}.conflict.{timestamp}{ext}
// e.g. notes/test.md -> notes/test.conflict.20060102150405.md
const CONFLICT_SUFFIX_RE = /\.conflict\.\d+(\.[^./]+)$/;

/**
 * 判断路径是否为服务端生成的冲突副本
 * Check whether a path is a server-generated conflict copy
 */
export const isConflictCopyPath = function (path: string): boolean {
  return CONFLICT_SUFFIX_RE.test(path);
};

/**
 * 由冲突副本路径推导出原始文件路径
 * Derive the original file path from a conflict copy path
 */
export const getOriginalPathFromConflictPath = function (conflictPath: string): string {
  return conflictPath.replace(CONFLICT_SUFFIX_RE, "$1");
};

/**
 * 冲突副本落盘后通知用户并写入同步日志；Notice 点击可直接打开冲突合并弹窗
 * Notify the user once a conflict copy lands on disk and record it in the sync log;
 * clicking the Notice opens the conflict resolve modal directly
 */
export const notifyConflictDetected = function (plugin: FastSync, conflictPath: string): void {
  const originalPath = getOriginalPathFromConflictPath(conflictPath);

  SyncLogManager.getInstance().addLog(
    'receive',
    'NoteConflictDetected',
    $("ui.conflict.log_message", { original: originalPath, copy: conflictPath }),
    'error',
    conflictPath,
    plugin.settings.vault
  );

  const fragment = activeDocument.createDocumentFragment();
  const text = fragment.createSpan({ text: $("ui.conflict.notice", { path: originalPath }) });
  text.addClass("fns-conflict-notice-text");
  const notice = new Notice(fragment, 10000);
  fragment.addEventListener("click", () => {
    notice.hide();
    void (async () => {
      const { ConflictResolveModal } = await import("../../views/conflict-resolve-modal");
      new ConflictResolveModal(plugin.app, plugin, originalPath, conflictPath).open();
    })();
  });
};
