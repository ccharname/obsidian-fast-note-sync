/**
 * 同步轮次中的消息 context 过滤决策（纯函数，便于单测）。
 *
 * 同步轮次中（activeCtx 非空）：
 *  - context 与本轮一致 → 正常处理；
 *  - 无 context：clientAutoMerge 下，NoteModifyAck 与实时 NoteSync* 推送必须放行（否则单飞上传永远等不到 Ack、
 *    远端改动被漏掉），标记 realtime，处理完不计入轮次进度；其余无 context 消息丢弃；
 *  - 带别的 context → 丢弃。
 */
export type ContextVerdict = "process" | "realtime" | "discard"

const REALTIME_NOTE_ACTIONS = new Set(["NoteModifyAck", "NoteSyncModify", "NoteSyncDelete", "NoteSyncRename"])

export function classifyContext(opts: {
  action: string
  msgContext: string | undefined
  activeContext: string | null
  autoMerge: boolean
}): ContextVerdict {
  const { action, msgContext, activeContext, autoMerge } = opts
  if (!activeContext) return "process"
  if (msgContext === activeContext) return "process"
  if (!msgContext && autoMerge && REALTIME_NOTE_ACTIONS.has(action)) return "realtime"
  return "discard"
}
