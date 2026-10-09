/**
 * Task ledger: one record per tool execution (or planned step of a multi-step plan).
 * It is the single place that knows what JARVIS did, what state it is in and whether
 * the result was verified — SYSTEM tools, Diagnostics and the model all read from here.
 *
 * Kept in memory with a sessionStorage mirror so a mobile browser that reloads the tab
 * after suspension does not lose the recent history. Capped; no secrets are stored.
 */

export type TaskState =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TaskCategory = 'phone' | 'web' | 'system'

export type TaskRecord = {
  id: string
  /** Groups the steps of one multi-step plan. */
  planId: string
  step: number
  steps: number
  category: TaskCategory
  tool: string
  /** Short human label of what was asked (never secrets). */
  intent: string
  state: TaskState
  startedAt: number
  endedAt: number | null
  progress: string
  result: string | null
  error: string | null
  /** true = outcome confirmed by a read-back; false = known unconfirmed; null = not applicable. */
  verified: boolean | null
}

const STORE_KEY = 'jarvis.tasks'
const MAX = 30
const TERMINAL: readonly TaskState[] = ['completed', 'failed', 'cancelled']

let records: TaskRecord[] = restore()
let seq = 0

function restore(): TaskRecord[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as TaskRecord[])
      .filter((t) => t && typeof t.id === 'string' && typeof t.state === 'string')
      .map((t) =>
        // A task that was mid-flight when the page died cannot still be running.
        TERMINAL.includes(t.state) ? t : { ...t, state: 'cancelled' as TaskState, endedAt: Date.now() },
      )
      .slice(-MAX)
  } catch {
    return []
  }
}

function persist(): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(records.slice(-MAX)))
  } catch {
    /* best effort */
  }
}

export function newPlanId(): string {
  return `p${Date.now().toString(36)}${(seq++).toString(36)}`
}

export function createTask(init: {
  planId: string
  step: number
  steps: number
  category: TaskCategory
  tool: string
  intent: string
}): TaskRecord {
  const rec: TaskRecord = {
    id: `t${Date.now().toString(36)}${(seq++).toString(36)}`,
    planId: init.planId,
    step: init.step,
    steps: init.steps,
    category: init.category,
    tool: init.tool,
    intent: init.intent.slice(0, 120),
    state: 'queued',
    startedAt: Date.now(),
    endedAt: null,
    progress: '',
    result: null,
    error: null,
    verified: null,
  }
  records.push(rec)
  if (records.length > MAX) records = records.slice(-MAX)
  persist()
  return rec
}

export function setTask(id: string, patch: Partial<Omit<TaskRecord, 'id'>>): void {
  const rec = records.find((t) => t.id === id)
  if (!rec) return
  // A finished task never comes back to life (late callbacks must not rewrite history).
  if (TERMINAL.includes(rec.state)) return
  Object.assign(rec, patch)
  if (TERMINAL.includes(rec.state) && rec.endedAt === null) rec.endedAt = Date.now()
  persist()
}

/** Mark everything not finished as cancelled (barge-in, new request, shutdown). */
export function cancelActiveTasks(reason = 'interrompida'): number {
  let n = 0
  for (const t of records) {
    if (!TERMINAL.includes(t.state)) {
      t.state = 'cancelled'
      t.endedAt = Date.now()
      t.error = reason
      n++
    }
  }
  if (n) persist()
  return n
}

export function recentTasks(n = 8): TaskRecord[] {
  return records.slice(-n)
}

export function activeTaskCount(): number {
  return records.filter((t) => !TERMINAL.includes(t.state)).length
}

const STATE_PT: Record<TaskState, string> = {
  queued: 'na fila',
  planning: 'planejando',
  running: 'executando',
  waiting: 'aguardando confirmação',
  verifying: 'verificando',
  completed: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada',
}

export function describeTask(t: TaskRecord): string {
  const base = `${t.tool} (${STATE_PT[t.state]})`
  if (t.state === 'completed') {
    return `${base}${t.verified === true ? ', confirmada' : t.verified === false ? ', sem confirmação' : ''}`
  }
  if (t.state === 'failed' || t.state === 'cancelled') return `${base}${t.error ? `: ${t.error}` : ''}`
  return base
}

export function taskSummary(n = 5): string {
  const list = recentTasks(n)
  if (!list.length) return 'Nenhuma tarefa executada nesta sessão.'
  return `Últimas tarefas: ${list.map(describeTask).join('; ')}.`
}
