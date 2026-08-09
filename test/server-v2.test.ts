import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"
import { getGoal } from "../src/state"

const TOOL_NAMES = [
  "clear_goal",
  "create_goal",
  "get_goal",
  "get_goal_history",
  "set_goal",
  "update_goal",
  "update_goal_objective",
  "update_goal_status",
].sort()

type ToolDraft = {
  add(tool: {
    name: string
    description: string
    input: unknown
    options?: { codemode?: boolean }
    execute: (args: unknown, context: unknown) => Promise<unknown>
  }): void
}

type MockCommandDraft = {
  get(name: string): { name: string; template: string } | undefined
  update(name: string, update: (command: { description?: string; template: string }) => void): void
}

type Registration = { dispose: () => Promise<void> }

function controlledStream() {
  const queue: Array<{ done: boolean; value?: unknown }> = []
  const waiters: Array<() => void> = []
  let ended = false
  return {
    push(value: unknown) {
      if (ended) return
      queue.push({ done: false, value })
      waiters.shift()?.()
    },
    end() {
      if (ended) return
      ended = true
      queue.push({ done: true })
      waiters.shift()?.()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = queue.shift()
        if (item) {
          if (item.done) return
          yield item.value
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

type MockContext = {
  options: Record<string, unknown>
  promptCalls: Array<{ sessionID: string; text: string; agents?: Array<{ name: string }> }>
  tools: Array<ToolDraft["add"] extends (tool: infer T) => void ? T : never>
  commandDraft: MockCommandDraft
  hooks: Record<string, (input: unknown) => void>
  systemParts: Array<{ type: string; text: string }>
  stream: ReturnType<typeof controlledStream>
  disposals: string[]
  command: {
    transform: (callback: (draft: MockCommandDraft) => void) => Promise<Registration>
  }
  tool: {
    transform: (callback: (draft: ToolDraft) => void) => Promise<Registration>
    hook: (name: string, callback: (input: unknown) => void) => Promise<Registration>
  }
  session: {
    hook: (name: string, callback: (input: unknown) => void) => Promise<Registration>
    prompt: (input: { sessionID: string; text: string; agents?: Array<{ name: string }> }) => Promise<unknown>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

function makeMockContext(options: Record<string, unknown> = {}): MockContext {
  const tools: MockContext["tools"] = []
  const hooks: MockContext["hooks"] = {}
  const promptCalls: MockContext["promptCalls"] = []
  const disposals: string[] = []
  const stream = controlledStream()
  const commandDraft: MockCommandDraft = {
    get: () => undefined,
    update: (name, update) => {
      const command = { name, template: "" }
      update(command)
      commandDraft.get = () => command
    },
  }
  const registration = (name: string): Registration => ({
    dispose: async () => {
      disposals.push(name)
    },
  })
  return {
    options,
    promptCalls,
    tools,
    commandDraft,
    hooks,
    systemParts: [],
    stream,
    disposals,
    command: {
      transform: async (callback) => {
        callback(commandDraft)
        return registration("command.transform")
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.push(tool) })
        return registration("tool.transform")
      },
      hook: async (name, callback) => {
        hooks[name] = callback
        return registration(`tool.hook:${name}`)
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
        return registration(`session.hook:${name}`)
      },
      prompt: async (input) => {
        promptCalls.push(input)
        return { id: "pending_1" }
      },
    },
    event: {
      subscribe: () => stream,
    },
  }
}

function toolContext(sessionID = "ses_v2", agent = "build") {
  return { sessionID, agent, messageID: "msg_1", id: "call_1" }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(await predicate()).toBe(true)
}

function goalTool(mock: MockContext, name: string) {
  const tool = mock.tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`expected V2 tool ${name} to be registered`)
  return tool
}

function contentOf(result: unknown) {
  const value = result as { content?: string }
  return typeof value.content === "string" ? value.content : String(result)
}

async function createGoalViaV2Tool(mock: MockContext, objective: string, agent = "build") {
  const tool = goalTool(mock, "create_goal")
  const result = await tool.execute({ objective }, toolContext("ses_v2", agent))
  return result
}

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-v2-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("default export exposes both V1 server and V2 setup", () => {
  expect(typeof plugin.server).toBe("function")
  expect(typeof plugin.setup).toBe("function")
  expect(plugin.id).toBe("local.goal-mode.server")
})

test("V2 setup registers goal tools with JSON Schema inputs, codemode:false, and {content} executors", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)

  expect(mock.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)

  for (const tool of mock.tools) {
    expect(tool.options?.codemode).toBe(false)
    expect(typeof tool.input).toBe("object")
    expect(tool.input).not.toBeNull()
    expect(tool.input).toMatchObject({ type: "object", properties: expect.any(Object), additionalProperties: false })
  }

  const created = await createGoalViaV2Tool(mock, "finish the V2 milestone")
  expect(created).toEqual({ content: expect.stringContaining('"status": "active"') })

  const getTool = goalTool(mock, "get_goal")
  const read = await getTool.execute({}, toolContext())
  expect(read).toEqual({ content: expect.stringContaining('"objective": "finish the V2 milestone"') })

  const completed = await goalTool(mock, "update_goal").execute(
    { status: "complete", evidence: "verified locally" },
    toolContext(),
  )
  expect(completed).toEqual({ content: expect.stringContaining('"completionEvidence": "verified locally"') })

  mock.stream.end()
  await cleanup()
  expect(mock.promptCalls).toHaveLength(0)
})

test("V2 setup registers the /goal command via command transform", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)

  const command = mock.commandDraft.get("goal")
  expect(command).toBeDefined()
  expect(command?.template).toContain('OpenCode goal mode command "/goal" was invoked')
  expect(command?.template).toContain("$ARGUMENTS")

  mock.stream.end()
  await cleanup()
})

test("V2 setup skips command registration when register_command is false", async () => {
  const mock = makeMockContext({ auto_continue: false, register_command: false })
  const cleanup = await plugin.setup(mock as never)

  expect(mock.commandDraft.get("goal")).toBeUndefined()
  expect(mock.disposals).not.toContain("command.transform")

  mock.stream.end()
  await cleanup()
})

test("V2 session context hook injects the goal-mode system reminder", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)

  const contextHook = mock.hooks["context"]!
  expect(contextHook).toBeTypeOf("function")
  const sessionContext = { sessionID: "ses_v2", agent: "build", system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} }
  await contextHook(sessionContext)
  expect(sessionContext.system.some((part) => part.type === "text" && part.text.includes("OpenCode goal mode policy:"))).toBe(true)

  // The reminder is not duplicated on a second hook invocation.
  await contextHook(sessionContext)
  expect(sessionContext.system).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test("V2 setup registers tool execute hooks", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)

  expect(mock.hooks["execute.before"]).toBeTypeOf("function")
  expect(mock.hooks["execute.after"]).toBeTypeOf("function")

  // The after hook must tolerate error statuses and extract text results.
  await mock.hooks["execute.after"]!({ tool: "task", status: "error", error: { message: "boom" } })
  await mock.hooks["execute.after"]!({
    tool: "task",
    status: "completed",
    result: { output: '<task id="t1" state="running">launch</task>' },
  })

  mock.stream.end()
  await cleanup()
})

test("V2 events account usage and checkpoints from step/usage events", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)
  await createGoalViaV2Tool(mock, "account usage from events")

  // Step events drive per-step token sums and checkpoints.
  mock.stream.push({
    type: "session.step.started",
    created: Date.now(),
    data: { sessionID: "ses_v2", assistantMessageID: "msg_step_1", agent: "build" },
  })
  mock.stream.push({
    type: "session.text.delta",
    created: Date.now(),
    data: { sessionID: "ses_v2", assistantMessageID: "msg_step_1", ordinal: 0, delta: "IMPLEMENTED_THE_FEATURE" },
  })
  mock.stream.push({
    type: "session.text.ended",
    created: Date.now(),
    data: { sessionID: "ses_v2", assistantMessageID: "msg_step_1", ordinal: 0, text: "IMPLEMENTED_THE_FEATURE" },
  })
  mock.stream.push({
    type: "session.step.ended",
    created: Date.now(),
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_step_1",
      finish: "stop",
      tokens: { input: 30, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })

  await waitFor(async () => {
    const read = await goalTool(mock, "get_goal").execute({}, toolContext())
    return contentOf(read).includes('"tokensUsed": 70')
  })
  const readAfterStep = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(readAfterStep)).toContain('"tokensUsed": 70')
  expect(contentOf(readAfterStep)).toContain("IMPLEMENTED_THE_FEATURE")

  // Cumulative usage.updated is authoritative and raises the accounted total.
  mock.stream.push({
    type: "session.usage.updated",
    created: Date.now(),
    data: { sessionID: "ses_v2", tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 10, write: 0 } } },
  })
  await waitFor(async () => contentOf(await goalTool(mock, "get_goal").execute({}, toolContext())).includes('"tokensUsed": 260'))

  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"tokensUsed": 260')
  expect(contentOf(read)).toContain("IMPLEMENTED_THE_FEATURE")

  mock.stream.end()
  await cleanup()
})

test("V2 failed steps account usage and replace stale assistant progress", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)
  await createGoalViaV2Tool(mock, "survive a failed model step")

  mock.stream.push({
    type: "session.step.started",
    created: 200,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_failed", agent: "build" },
  })
  mock.stream.push({
    type: "session.text.delta",
    created: 201,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_failed", delta: "partial response" },
  })
  mock.stream.push({
    type: "session.step.failed",
    created: 202,
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_failed",
      tokens: { input: 20, output: 3, reasoning: 2, cache: { read: 5, write: 0 } },
      error: { type: "provider.internal", message: "upstream failed" },
    },
  })

  await waitFor(async () => {
    const goal = await getGoal("ses_v2")
    return goal?.lastAssistantMessageID === "msg_failed" && goal.tokensUsed === 30
  })

  mock.stream.end()
  await cleanup()
})

test("V2 idle event triggers auto-continue via ctx.session.prompt", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_auto_turns: 5 })
  const cleanup = await plugin.setup(mock as never)
  await createGoalViaV2Tool(mock, "auto-continue from idle events")

  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })

  await waitFor(() => mock.promptCalls.length === 1)
  expect(mock.promptCalls[0]?.sessionID).toBe("ses_v2")
  expect(mock.promptCalls[0]?.text).toContain("Continue working toward the active session goal")
  expect(mock.promptCalls[0]?.agents).toEqual([{ name: "build" }])

  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"autoTurns": 1')

  mock.stream.end()
  await cleanup()
})

test("V2 idle continuation waits for a running child session", async () => {
  const mock = makeMockContext({ min_continue_interval_seconds: 1 })
  const cleanup = await plugin.setup(mock as never)
  await createGoalViaV2Tool(mock, "wait for delegated work")

  mock.stream.push({ type: "session.created", created: 100, data: { sessionID: "child", parentID: "ses_v2" } })
  mock.stream.push({ type: "session.idle", created: 101, data: { sessionID: "ses_v2" } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mock.promptCalls).toHaveLength(0)

  mock.stream.push({ type: "session.deleted", created: 102, data: { sessionID: "child" } })
  mock.stream.push({ type: "session.idle", created: 103, data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length === 1)

  mock.stream.end()
  await cleanup()
})

test("V2 idle auto-continue is suppressed for plan-agent goals", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_auto_turns: 5 })
  const cleanup = await plugin.setup(mock as never)
  await createGoalViaV2Tool(mock, "plan-mode goal must stay paused", "plan")

  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(mock.promptCalls).toHaveLength(0)
  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"status": "paused"')

  mock.stream.end()
  await cleanup()
})

test("V2 cleanup disposes registrations and stops the event consumer", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await plugin.setup(mock as never)
  await createGoalViaV2Tool(mock, "cleanup lifecycle")

  mock.stream.end()
  await cleanup()

  expect(mock.disposals).toEqual(
    expect.arrayContaining(["command.transform", "tool.transform", "tool.hook:execute.before", "tool.hook:execute.after", "session.hook:context"]),
  )
  // Events pushed after cleanup must not throw or mutate state.
  mock.stream.push({
    type: "session.usage.updated",
    created: Date.now(),
    data: { sessionID: "ses_v2", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"tokensUsed": 0')
})
