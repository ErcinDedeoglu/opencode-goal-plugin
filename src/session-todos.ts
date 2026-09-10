export type SessionTodo = {
  content: string
  status: string
  priority?: string
}

const MAX_LISTED_REMAINING = 8
const MAX_TODO_CONTENT_CHARS = 120

export const TODO_NOT_COMPLETION =
  "Completing every todo does not complete the goal. Close the goal only with update_goal after an evidence audit. " +
  "Do not add todos whose job is to close, complete, or update the goal."

const GOAL_TOOL_NAME = /\b(?:update_goal|create_goal|get_goal|clear_goal|set_goal|update_goal_status|update_goal_objective)\b/i
const CLOSE_THE_GOAL = /\b(?:close|complete|finish)\s+(?:the\s+)?(?:session\s+)?goal\b/i
const MARK_GOAL_CLOSED = /\bmark\s+(?:the\s+)?goal\s+(?:as\s+)?(?:complete|completed|done|unmet|closed)\b/i
const AND_CLOSE_GOAL = /\band\s+close\s+(?:the\s+)?goal\b/i

export function isGoalLifecycleTodo(content: string) {
  const text = content.trim()
  if (!text) return false
  return GOAL_TOOL_NAME.test(text) || CLOSE_THE_GOAL.test(text) || MARK_GOAL_CLOSED.test(text) || AND_CLOSE_GOAL.test(text)
}

function normalizeSingleInProgress(todos: SessionTodo[]) {
  let seenInProgress = false
  return todos.map((todo) => {
    if (todo.status !== "in_progress") return todo
    if (seenInProgress) return { ...todo, status: "pending" }
    seenInProgress = true
    return todo
  })
}

function sameTodos(left: SessionTodo[], right: SessionTodo[]) {
  if (left.length !== right.length) return false
  return left.every((todo, index) => {
    const other = right[index]
    return (
      other != null &&
      todo.content === other.content &&
      todo.status === other.status &&
      todo.priority === other.priority
    )
  })
}

export function sanitizeSessionTodos(todos: SessionTodo[]) {
  return normalizeSingleInProgress(todos.filter((todo) => !isGoalLifecycleTodo(todo.content)))
}

export function applyTodowriteSanitize(tool: unknown, args: unknown): { args: unknown; changed: boolean } {
  if (typeof tool !== "string" || tool.toLowerCase() !== "todowrite") return { args, changed: false }
  if (isRecord(args) && Array.isArray(args.todos)) {
    const parsed = parseSessionTodos(args.todos)
    if (!parsed) return { args, changed: false }
    const next = sanitizeSessionTodos(parsed)
    if (sameTodos(next, parsed)) return { args, changed: false }
    return { args: { ...args, todos: next }, changed: true }
  }
  const parsed = parseSessionTodos(args)
  if (!parsed) return { args, changed: false }
  const next = sanitizeSessionTodos(parsed)
  if (sameTodos(next, parsed)) return { args, changed: false }
  return { args: next, changed: true }
}

export function rewriteTodowriteArgs(tool: unknown, holder: { args?: unknown } | null | undefined) {
  if (!holder) return
  const { args, changed } = applyTodowriteSanitize(tool, holder.args)
  if (changed) holder.args = args
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clip(value: string, max = MAX_TODO_CONTENT_CHARS) {
  const chars = [...value]
  if (chars.length <= max) return value
  return `${chars.slice(0, max).join("")}…`
}

function asTodo(value: unknown): SessionTodo | undefined {
  if (!isRecord(value) || typeof value.content !== "string") return undefined
  const content = value.content.trim()
  if (!content) return undefined
  const status = typeof value.status === "string" && value.status.trim() ? value.status.trim() : "pending"
  const priority = typeof value.priority === "string" && value.priority.trim() ? value.priority.trim() : undefined
  return priority ? { content, status, priority } : { content, status }
}

export function parseSessionTodos(value: unknown): SessionTodo[] | undefined {
  if (value == null) return undefined
  if (typeof value === "string") {
    try {
      return parseSessionTodos(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    const todos = value.map(asTodo).filter((todo): todo is SessionTodo => Boolean(todo))
    return todos
  }
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.todos)) return parseSessionTodos(value.todos)
  if (Array.isArray(value.data)) return parseSessionTodos(value.data)
  if (isRecord(value.data)) return parseSessionTodos(value.data)
  if (isRecord(value.properties)) return parseSessionTodos(value.properties)
  if (isRecord(value.metadata)) return parseSessionTodos(value.metadata)
  if (isRecord(value.structured)) return parseSessionTodos(value.structured)
  if (typeof value.output === "string" || Array.isArray(value.output)) return parseSessionTodos(value.output)
  return undefined
}

export function todosFromToolPayload(tool: unknown, payload: unknown): SessionTodo[] | undefined {
  if (typeof tool !== "string" || tool.toLowerCase() !== "todowrite") return undefined
  return parseSessionTodos(payload)
}

function countByStatus(todos: SessionTodo[]) {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0, other: 0 }
  for (const todo of todos) {
    if (todo.status === "pending") counts.pending += 1
    else if (todo.status === "in_progress") counts.in_progress += 1
    else if (todo.status === "completed") counts.completed += 1
    else if (todo.status === "cancelled") counts.cancelled += 1
    else counts.other += 1
  }
  return counts
}

function remainingTodos(todos: SessionTodo[]) {
  const open = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
  return [
    ...open.filter((todo) => todo.status === "in_progress"),
    ...open.filter((todo) => todo.status !== "in_progress"),
  ]
}

export function formatTodoProgress(todos: SessionTodo[] | undefined): string | null {
  if (!todos) return null
  const header = "OpenCode session todos (work breakdown only; not goal completion):"
  if (todos.length === 0) {
    return [
      header,
      "- None recorded. If remaining work has 3 or more distinct steps, use todowrite with brief actionable items. " +
        "Do not paste the full goal objective into a todo.",
      TODO_NOT_COMPLETION,
    ].join("\n")
  }

  const counts = countByStatus(todos)
  const remaining = remainingTodos(todos)
  const remainingCount = remaining.length
  const parts = [
    `${counts.in_progress} in_progress`,
    `${counts.pending} pending`,
    `${counts.completed} completed`,
  ]
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`)
  if (counts.other) parts.push(`${counts.other} other`)
  const lines = [
    header,
    `- Remaining: ${remainingCount}/${todos.length} (${parts.join(", ")})`,
  ]
  const listed = remaining.slice(0, MAX_LISTED_REMAINING)
  for (const todo of listed) {
    lines.push(`- ${todo.status}: ${clip(todo.content)}`)
  }
  const extra = remaining.length - listed.length
  if (extra > 0) lines.push(`- pending: … (+${extra} more)`)
  lines.push(TODO_NOT_COMPLETION)
  return lines.join("\n")
}

type TodoClient = {
  session?: {
    todo?: (input: never) => Promise<unknown>
  }
}

export async function fetchSessionTodos(client: unknown, sessionID: string): Promise<SessionTodo[] | undefined> {
  const todo = (client as TodoClient | undefined)?.session?.todo
  if (typeof todo !== "function") return undefined
  for (const args of [{ path: { sessionID } }, { path: { id: sessionID } }]) {
    try {
      const parsed = parseSessionTodos(await todo(args as never))
      if (parsed) return parsed
    } catch {
      // GET is best-effort; event cache remains the fallback.
    }
  }
  return undefined
}

export class SessionTodoTracker {
  private readonly todos = new Map<string, SessionTodo[]>()
  private readonly client: unknown

  constructor(client?: unknown) {
    this.client = client
  }

  remember(sessionID: string, todos: SessionTodo[]) {
    this.todos.set(sessionID, sanitizeSessionTodos(todos))
  }

  forget(sessionID: string) {
    this.todos.delete(sessionID)
  }

  rememberFromEvent(sessionID: string | undefined, payload: unknown) {
    if (typeof sessionID !== "string") return
    const todos = parseSessionTodos(payload)
    if (todos) this.remember(sessionID, todos)
  }

  rememberFromTool(sessionID: string | undefined, tool: unknown, payload: unknown) {
    if (typeof sessionID !== "string") return
    const todos = todosFromToolPayload(tool, payload)
    if (todos) this.remember(sessionID, todos)
  }

  peek(sessionID: string) {
    return this.todos.get(sessionID)
  }

  async resolve(sessionID: string) {
    const fetched = await fetchSessionTodos(this.client, sessionID)
    if (fetched) {
      this.remember(sessionID, fetched)
      return fetched
    }
    return this.peek(sessionID)
  }
}
