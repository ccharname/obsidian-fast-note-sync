// src/lib/ui/status_bar_manager.ts

import { setIcon } from 'obsidian';
import type FastSync from '../../main';
import { SyncLogManager } from '../sync/sync_log_manager';

/**
 * Manages the status bar progress indicator.
 * 专门管理状态栏进度指示器。
 */
export class StatusBarManager {
  private plugin: FastSync;

  // DOM elements / DOM 元素
  private statusBarItem: HTMLElement | null = null;
  private statusBarPhaseLabel: HTMLElement | null = null;
  private statusBarProgressBar: HTMLElement | null = null;
  private statusBarFill: HTMLElement | null = null;
  private statusBarPct: HTMLElement | null = null;
  private statusBarCheck: HTMLElement | null = null;
  // 失败项红点 / Failed-item red dot badge
  private statusBarFailedBadge: HTMLElement | null = null;
  private unsubscribeFailedCount: (() => void) | null = null;

  // Progress protection / 进度值保护，确保不回退
  private lastPct = 0;

  constructor(plugin: FastSync) {
    this.plugin = plugin;
  }

  /**
   * Initialize status bar and pre-create DOM elements.
   * 初始化状态栏，并预先创建所有子 DOM 元素，消除闪烁。
   */
  init(): void {
    if (this.statusBarItem) return;

    this.statusBarItem = this.plugin.addStatusBarItem();
    this.statusBarItem.addClass("fns-hidden");
    this.statusBarItem.addClass("fast-note-sync-status-bar-progress");

    // Create phase label (↑ / ↓) / 创建阶段标签
    this.statusBarPhaseLabel = this.statusBarItem.createSpan("fns-phase-label");

    // Create progress bar / 创建进度条轨道与填充
    this.statusBarProgressBar = this.statusBarItem.createDiv("fast-note-sync-progress-bar");
    this.statusBarFill = this.statusBarProgressBar.createDiv("fast-note-sync-progress-fill");

    // Create check icon / 创建完成勾号
    this.statusBarCheck = this.statusBarItem.createSpan("fast-note-sync-progress-check fns-status-bar-check fns-hidden");
    setIcon(this.statusBarCheck, "check");

    // Create percentage or text node / 创建百分比或文本节点
    this.statusBarPct = this.statusBarItem.createDiv("fast-note-sync-progress-text fns-progress-pct");

    // Create failed-item red dot badge, hidden until there are unread failures.
    // 创建失败项红点，未读失败数为 0 时隐藏。
    this.statusBarFailedBadge = this.statusBarItem.createSpan("fns-status-bar-failed-badge fns-hidden");

    // Clicking the status bar jumps into the log view filtered to "failed only" and clears the badge.
    // 点击状态栏跳转到日志视图并自动切到"仅看失败"，同时清除红点。
    this.statusBarItem.addEventListener("click", () => {
      if (SyncLogManager.getInstance().getUnreadFailedCount() > 0) {
        void this.plugin.activateLogView(true);
      }
    });

    this.unsubscribeFailedCount = SyncLogManager.getInstance().subscribeUnreadFailedCount((count) => {
      if (!this.statusBarFailedBadge) return;
      if (count > 0) {
        this.statusBarFailedBadge.removeClass("fns-hidden");
        this.statusBarFailedBadge.setText(count > 99 ? "99+" : String(count));
      } else {
        this.statusBarFailedBadge.addClass("fns-hidden");
        this.statusBarFailedBadge.setText("");
      }
    });
  }

  /**
   * Remove status bar item on unload.
   * 卸载时移除状态栏。
   */
  unload(): void {
    if (this.unsubscribeFailedCount) {
      this.unsubscribeFailedCount();
      this.unsubscribeFailedCount = null;
    }
    if (this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
  }

  /**
   * Dynamic rich render called by SyncProgressTracker.
   * 由进度追踪器触发的富渲染。
   */
  render(pct: number, detail: string, phase: 'hash' | 'upload' | 'download' | 'idle'): void {
    if (!this.statusBarItem) return;

    this.statusBarItem.removeClass("fns-hidden");
    this.statusBarItem.addClass("fns-status-bar-progress");

    // 1. Update Phase Label / 更新阶段标签
    if (this.statusBarPhaseLabel) {
      if (phase === 'hash') {
        this.statusBarPhaseLabel.setText('🔍');
        this.statusBarPhaseLabel.removeClass("fns-hidden");
      } else if (phase === 'upload') {
        this.statusBarPhaseLabel.setText('↑');
        this.statusBarPhaseLabel.removeClass("fns-hidden");
      } else if (phase === 'download') {
        this.statusBarPhaseLabel.setText('↓');
        this.statusBarPhaseLabel.removeClass("fns-hidden");
      } else {
        this.statusBarPhaseLabel.setText('');
        this.statusBarPhaseLabel.addClass("fns-hidden");
      }
    }

    // 2. Update Progress Bar / 更新进度条
    if (pct < this.lastPct) {
      pct = this.lastPct;
    } else {
      this.lastPct = pct;
    }

    if (this.statusBarFill) {
      this.statusBarFill.setCssProps({ width: `${pct}%` });
    }

    if (this.statusBarPct) {
      this.statusBarPct.setText(`${pct}%`);
    }

    this.statusBarItem.setAttribute("aria-label", detail || `Syncing ${pct}%`);

    if (pct === 100) {
      this.showCompleted();
    } else {
      if (this.statusBarProgressBar) this.statusBarProgressBar.removeClass("fns-hidden");
      if (this.statusBarCheck) this.statusBarCheck.addClass("fns-hidden");
    }
  }

  /**
   * Classical update signature for backward compatibility.
   * 经典更新签名，用于向后兼容及零星单点调用。
   */
  update(text: string, current?: number, total?: number): void {
    if (!this.statusBarItem) return;

    if (!text && current === undefined && total === undefined) {
      this.hide();
      return;
    }

    this.statusBarItem.removeClass("fns-hidden");

    if (current !== undefined && total !== undefined && total > 0) {
      this.statusBarItem.addClass("fns-status-bar-progress");
      if (this.statusBarProgressBar) this.statusBarProgressBar.removeClass("fns-hidden");
      if (this.statusBarPhaseLabel) this.statusBarPhaseLabel.addClass("fns-hidden");

      let percentage = Math.min(100, Math.round((current / total) * 100));
      if (percentage < this.lastPct) {
        percentage = this.lastPct;
      } else {
        this.lastPct = percentage;
      }

      if (this.statusBarFill) this.statusBarFill.setCssProps({ width: `${percentage}%` });
      if (this.statusBarPct) this.statusBarPct.setText(`${percentage}%`);
      this.statusBarItem.setAttribute("aria-label", text);

      if (percentage === 100) {
        if (this.statusBarProgressBar) this.statusBarProgressBar.addClass("fns-hidden");
        if (this.statusBarCheck) this.statusBarCheck.removeClass("fns-hidden");
      } else {
        if (this.statusBarProgressBar) this.statusBarProgressBar.removeClass("fns-hidden");
        if (this.statusBarCheck) this.statusBarCheck.addClass("fns-hidden");
      }
    } else {
      if (text) {
        this.statusBarItem.addClass("fns-status-bar-progress");
        if (this.statusBarProgressBar) this.statusBarProgressBar.addClass("fns-hidden");
        if (this.statusBarPhaseLabel) this.statusBarPhaseLabel.addClass("fns-hidden");

        const isCompleted = text.includes("完成") || text.toLowerCase().includes("complete");
        if (isCompleted) {
          if (this.statusBarCheck) this.statusBarCheck.removeClass("fns-hidden");
        } else {
          if (this.statusBarCheck) this.statusBarCheck.addClass("fns-hidden");
        }
        if (this.statusBarPct) this.statusBarPct.setText(text);
      } else {
        this.statusBarItem.removeClass("fns-status-bar-progress");
        if (this.statusBarPct) this.statusBarPct.setText("");
      }
    }
  }

  /**
   * Hide the status bar completely.
   * 彻底隐藏状态栏。
   */
  hide(): void {
    if (this.statusBarItem) {
      this.statusBarItem.addClass("fns-hidden");
      this.statusBarItem.removeClass("fns-status-bar-progress");
    }
    this.lastPct = 0;
  }

  /**
   * Transition to completed state.
   * 显示已完成状态。
   */
  showCompleted(): void {
    if (this.statusBarProgressBar) this.statusBarProgressBar.addClass("fns-hidden");
    if (this.statusBarCheck) this.statusBarCheck.removeClass("fns-hidden");
  }

  /**
   * Transition to failed state.
   * 显示同步失败状态。
   */
  showFailed(): void {
    if (this.statusBarProgressBar) this.statusBarProgressBar.addClass("fns-hidden");
    if (this.statusBarCheck) this.statusBarCheck.addClass("fns-hidden");
    if (this.statusBarPct) this.statusBarPct.setText("同步失败");
  }
}
