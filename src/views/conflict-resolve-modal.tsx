import { Root, createRoot } from "react-dom/client";
import { Modal, App, TFile, setIcon, normalizePath } from "obsidian";
import * as React from "react";

import { HistoryDetail } from "./note-history/history-detail";
import { diffLines, canDiffLines, LineDiff } from "../lib/utils/diff_lines";
import { showSyncNotice, vaultDelete, dumpError } from "../lib/utils/helpers";
import { SyncLogManager } from "../lib/sync/sync_log_manager";
import type FastSync from "../main";
import { $ } from "../i18n/lang";


interface ConflictResolveViewProps {
    plugin: FastSync;
    originalPath: string;
    conflictPath: string;
    onClose: () => void;
}

const ConflictResolveView: React.FC<ConflictResolveViewProps> = ({ plugin, originalPath, conflictPath, onClose }) => {
    const [loading, setLoading] = React.useState(true);
    const [originalMissing, setOriginalMissing] = React.useState(false);
    const [originalContent, setOriginalContent] = React.useState("");
    const [conflictContent, setConflictContent] = React.useState("");
    const [diffs, setDiffs] = React.useState<LineDiff[] | null>(null);
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        void (async () => {
            const normalizedOriginal = normalizePath(originalPath);
            const normalizedConflict = normalizePath(conflictPath);
            const originalFile = plugin.app.vault.getFileByPath(normalizedOriginal);
            const conflictFile = plugin.app.vault.getFileByPath(normalizedConflict);

            if (!conflictFile) {
                onClose();
                return;
            }

            const cContent = await plugin.app.vault.read(conflictFile);
            setConflictContent(cContent);

            if (!originalFile) {
                setOriginalMissing(true);
                setLoading(false);
                return;
            }

            const oContent = await plugin.app.vault.read(originalFile);
            setOriginalContent(oContent);

            if (canDiffLines(oContent, cContent)) {
                setDiffs(diffLines(oContent, cContent));
            } else {
                setDiffs(null);
            }
            setLoading(false);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const withBusy = async (fn: () => Promise<void>) => {
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            dumpError("ConflictResolveModal action failed:", e);
            showSyncNotice($("ui.conflict.action_failed"));
        } finally {
            setBusy(false);
        }
    };

    const handleKeepCurrent = () => withBusy(async () => {
        const conflictFile = plugin.app.vault.getFileByPath(normalizePath(conflictPath));
        if (conflictFile instanceof TFile) {
            await vaultDelete(plugin.app.vault, conflictFile);
        }
        SyncLogManager.getInstance().addLog('info', 'NoteConflictResolved', $("ui.conflict.log_resolved_keep_current", { path: originalPath }), 'success', originalPath, plugin.settings.vault);
        showSyncNotice($("ui.conflict.keep_current_success"));
        onClose();
    });

    const handleOverwriteWithCopy = () => withBusy(async () => {
        const originalFile = plugin.app.vault.getFileByPath(normalizePath(originalPath));
        if (!(originalFile instanceof TFile)) {
            showSyncNotice($("ui.conflict.original_missing"));
            return;
        }
        await plugin.app.vault.modify(originalFile, conflictContent);
        const conflictFile = plugin.app.vault.getFileByPath(normalizePath(conflictPath));
        if (conflictFile instanceof TFile) {
            await vaultDelete(plugin.app.vault, conflictFile);
        }
        SyncLogManager.getInstance().addLog('info', 'NoteConflictResolved', $("ui.conflict.log_resolved_overwrite", { path: originalPath }), 'success', originalPath, plugin.settings.vault);
        showSyncNotice($("ui.conflict.overwrite_success"));
        onClose();
    });

    const handleSideBySide = () => withBusy(async () => {
        const originalFile = plugin.app.vault.getFileByPath(normalizePath(originalPath));
        const conflictFile = plugin.app.vault.getFileByPath(normalizePath(conflictPath));
        if (originalFile instanceof TFile) {
            const leaf = plugin.app.workspace.getLeaf('tab');
            await leaf.openFile(originalFile);
        }
        if (conflictFile instanceof TFile) {
            const splitLeaf = plugin.app.workspace.getLeaf('split', 'vertical');
            await splitLeaf.openFile(conflictFile);
        }
        onClose();
    });

    if (loading) {
        return <div className="conflict-resolve-loading">{$("ui.history.loading")}</div>;
    }

    return (
        <div className="conflict-resolve-container">
            {originalMissing ? (
                <div className="conflict-resolve-warning">{$("ui.conflict.original_missing")}</div>
            ) : diffs ? (
                <div className="note-history-view conflict-resolve-diff-wrap">
                    <HistoryDetail
                        content={conflictContent}
                        diffs={diffs}
                        showOnlyDiff={false}
                        showOriginal={false}
                        path={originalPath}
                    />
                </div>
            ) : (
                <div className="conflict-resolve-warning">{$("ui.conflict.diff_too_large")}</div>
            )}

            <div className="conflict-resolve-actions">
                {!originalMissing && (
                    <button disabled={busy} onClick={() => void handleKeepCurrent()} title={$("ui.conflict.keep_current_desc")}>
                        {$("ui.conflict.keep_current")}
                    </button>
                )}
                {!originalMissing && (
                    <button disabled={busy} onClick={() => void handleOverwriteWithCopy()} title={$("ui.conflict.overwrite_with_copy_desc")}>
                        {$("ui.conflict.overwrite_with_copy")}
                    </button>
                )}
                {originalMissing && (
                    <button disabled={busy} onClick={() => void handleKeepCurrent()} title={$("ui.conflict.keep_current_desc")}>
                        {$("ui.conflict.delete_conflict_copy")}
                    </button>
                )}
                <button disabled={busy} onClick={() => void handleSideBySide()} title={$("ui.conflict.side_by_side_desc")}>
                    {$("ui.conflict.side_by_side")}
                </button>
            </div>
        </div>
    );
};

export class ConflictResolveModal extends Modal {
    private root: Root | null = null;

    constructor(app: App, private plugin: FastSync, private originalPath: string, private conflictPath: string) {
        super(app);
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        this.containerEl.addClass("conflict-resolve-modal");

        titleEl.empty();
        const iconSpan = titleEl.createSpan({ cls: "title-prefix" });
        setIcon(iconSpan, "git-merge");
        iconSpan.createSpan({ text: ` ${$("ui.conflict.modal_title")}：` });
        titleEl.createEl("span", { text: this.originalPath, cls: "title-path" });

        this.root = createRoot(contentEl);
        this.root.render(
            <ConflictResolveView
                plugin={this.plugin}
                originalPath={this.originalPath}
                conflictPath={this.conflictPath}
                onClose={() => this.close()}
            />
        );
    }

    onClose() {
        if (this.root) {
            this.root.unmount();
        }
        this.contentEl.empty();
    }
}
