import type { PathState } from "../sync/server_merge_core"

interface Adapter {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  mkdir(path: string): Promise<void>
  list(path: string): Promise<{ files: string[]; folders: string[] }>
}
interface Options { adapter: Adapter; dir: string; legacyPath: string }
interface Envelope { version: 1; sequence: number; path: string; state: PathState | null; digest: string }
const digest = async (s: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), b => b.toString(16).padStart(2, "0")).join("")
const payload = (e: Omit<Envelope, "digest">): string => JSON.stringify([e.version, e.sequence, e.path, e.state])
const validState = (v: unknown): v is PathState => !!v && typeof v === "object" && !Array.isArray(v) && (typeof (v as PathState).baseContent === "string" || (v as PathState).baseContent === null) && typeof (v as PathState).revision === "string" && /^\d+$/.test((v as PathState).revision)

/** Per-note alternating, checksummed slots retain the last commit after a torn write.
 * Obsidian adapter.rename rejects existing destinations; commits use write, never rename.
 * Each save serializes only one note, including during first-run migration.
 */
export class MergeJournal {
  private sequences = new Map<string, number>()
  private ready = false
  constructor(private options: Options) {}
  async load(): Promise<Record<string, PathState>> {
    const { adapter: a, dir, legacyPath } = this.options
    const states: Record<string, PathState> = Object.create(null)
    if (await a.exists(legacyPath)) {
      const legacy: unknown = JSON.parse(await a.read(legacyPath))
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw Error("Invalid legacy merge journal")
      for (const [p, s] of Object.entries(legacy)) {
        if (!validState(s)) throw Error(`Invalid legacy merge state: ${p}`)
        states[p] = s
      }
    }
    if (!(await a.exists(dir))) await a.mkdir(dir)
    const files = (await a.list(dir)).files.filter(f => /\/[0-9a-f]{64}\.[01]\.json$/.test(f))
    const selected = new Map<string, Envelope>(), present = new Set<string>()
    for (let i = 0; i < files.length; i += 32) await Promise.all(files.slice(i, i + 32).map(async file => {
      const stem = file.slice(file.lastIndexOf("/") + 1, -7)
      present.add(stem)
      try {
        const e = JSON.parse(await a.read(file)) as Envelope
        if (e.version !== 1 || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || typeof e.path !== "string" || (e.state !== null && !validState(e.state)) || typeof e.digest !== "string") return
        if (await digest(e.path) !== stem || await digest(payload(e)) !== e.digest) return
        const old = selected.get(stem)
        if (!old || e.sequence > old.sequence) selected.set(stem, e)
      } catch { /* A torn slot may have an intact predecessor. */ }
    }))
    for (const stem of present) if (!selected.has(stem)) throw Error(`No valid merge journal slot: ${stem}`)
    this.sequences.clear()
    for (const e of selected.values()) {
      this.sequences.set(e.path, e.sequence)
      if (e.state === null) delete states[e.path]
      else states[e.path] = e.state
    }
    this.ready = true
    return states
  }
  async save(path: string, state: PathState | null): Promise<void> {
    if (!this.ready) throw Error("Merge journal must load before save")
    if (state !== null && !validState(state)) throw Error(`Invalid merge state: ${path}`)
    const sequence = (this.sequences.get(path) ?? 0) + 1
    if (!Number.isSafeInteger(sequence)) throw Error("Merge journal sequence overflow")
    const body: Omit<Envelope, "digest"> = { version: 1, sequence, path, state: state === null ? null : JSON.parse(JSON.stringify(state)) as PathState }
    const e: Envelope = { ...body, digest: await digest(payload(body)) }
    const file = `${this.options.dir}/${await digest(path)}.${sequence % 2}.json`, text = JSON.stringify(e)
    await this.options.adapter.write(file, text)
    if (await this.options.adapter.read(file) !== text) throw Error(`Merge journal verification failed: ${path}`)
    this.sequences.set(path, sequence)
  }
}
