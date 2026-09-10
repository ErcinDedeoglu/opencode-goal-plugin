import { expect, test } from "bun:test"
import {
  TODO_NOT_COMPLETION,
  fetchSessionTodos,
  formatTodoProgress,
  parseSessionTodos,
  todosFromToolPayload,
} from "../src/session-todos"
import { continuationPrompt, limitPrompt, systemReminder } from "../src/prompts"
import type { GoalSnapshot } from "../src/state"

const sampleGoal = {
  sessionID: "ses_1",
  objective: "translate the UI",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
  lastAccountedAt: null,
  autoTurns: 0,
  lastContinuationAt: null,
  continuationFailures: 0,
  lastStatus: null,
  maxAutoTurns: null,
  maxDurationSeconds: null,
  noProgressTokenThreshold: 50,
  maxNoProgressTurns: 2,
  noProgressTurns: 0,
  budgetWrapupSent: false,
  stopReason: null,
  history: [],
  checkpoints: [],
  lastCheckpoint: null,
  lastAssistantText: "",
  lastAssistantMessageID: "",
  lastPromptAgent: null,
  awaitingContinuationProgress: false,
  continuationBaselineMessageID: "",
  continuationBaselineSummary: "",
  remainingTokens: null,
  sampledAt: 1,
} as GoalSnapshot

test("parseSessionTodos accepts arrays, wrappers, and JSON strings", () => {
  const items = [
    { content: "write tests", status: "in_progress", priority: "high" },
    { content: "  ", status: "pending" },
    { content: "update README", status: "pending" },
  ]
  expect(parseSessionTodos(items)).toEqual([
    { content: "write tests", status: "in_progress", priority: "high" },
    { content: "update README", status: "pending" },
  ])
  expect(parseSessionTodos({ todos: items })).toEqual(parseSessionTodos(items))
  expect(parseSessionTodos({ data: items })).toEqual(parseSessionTodos(items))
  expect(parseSessionTodos({ metadata: { todos: items } })).toEqual(parseSessionTodos(items))
  expect(parseSessionTodos(JSON.stringify(items))).toEqual(parseSessionTodos(items))
  expect(parseSessionTodos([])).toEqual([])
  expect(parseSessionTodos("not-json")).toBeUndefined()
})

test("todosFromToolPayload only reads todowrite payloads", () => {
  const todos = [{ content: "ship it", status: "pending" }]
  expect(todosFromToolPayload("todowrite", { todos })).toEqual([{ content: "ship it", status: "pending" }])
  expect(todosFromToolPayload("bash", { todos })).toBeUndefined()
})

test("formatTodoProgress lists remaining work and refuses to treat todos as completion", () => {
  const formatted = formatTodoProgress([
    { content: "write tests", status: "in_progress" },
    { content: "update README", status: "pending" },
    { content: "old step", status: "completed" },
    { content: "dropped", status: "cancelled" },
  ])
  expect(formatted).toContain("Remaining: 2/4 (1 in_progress, 1 pending, 1 completed, 1 cancelled)")
  expect(formatted).toContain("- in_progress: write tests")
  expect(formatted).toContain("- pending: update README")
  expect(formatted).not.toContain("old step")
  expect(formatted).toContain(TODO_NOT_COMPLETION)

  expect(formatTodoProgress([])).toContain("None recorded")
  expect(formatTodoProgress([])).toContain(TODO_NOT_COMPLETION)
  expect(formatTodoProgress(undefined)).toBeNull()
})

test("formatTodoProgress clips long items and caps the remaining list", () => {
  const todos = Array.from({ length: 10 }, (_, index) => ({
    content: index === 0 ? "😀".repeat(130) : `step ${index}`,
    status: "pending" as const,
  }))
  const formatted = formatTodoProgress(todos)!
  expect(formatted).toContain("Remaining: 10/10")
  expect(formatted).toContain("(+2 more)")
  expect([...formatted.split("\n")[2]!.replace("- pending: ", "")].length).toBe(121)
})

test("fetchSessionTodos is best-effort across SDK path shapes", async () => {
  const calls: unknown[] = []
  const client = {
    session: {
      todo: async (input: unknown) => {
        calls.push(input)
        if (JSON.stringify(input).includes('"id"')) {
          return { data: [{ content: "from id path", status: "pending" }] }
        }
        throw new Error("no sessionID field")
      },
    },
  }
  expect(await fetchSessionTodos(client, "ses_1")).toEqual([{ content: "from id path", status: "pending" }])
  expect(calls).toHaveLength(2)
  expect(await fetchSessionTodos({ session: {} }, "ses_1")).toBeUndefined()
})

test("continuation and limit prompts include todo progress without implying goal completion", () => {
  const todos = [{ content: "write tests", status: "completed" }]
  const continued = continuationPrompt(sampleGoal, todos)
  expect(continued).toContain("Continue working toward the active session goal")
  expect(continued).toContain("Remaining: 0/1 (0 in_progress, 0 pending, 1 completed)")
  expect(continued).toContain(TODO_NOT_COMPLETION)
  expect(continuationPrompt(sampleGoal)).not.toContain("OpenCode session todos")

  const limited = limitPrompt({ ...sampleGoal, status: "usageLimited", stopReason: "max auto turns" }, todos)
  expect(limited).toContain(TODO_NOT_COMPLETION)
  expect(limited).toContain("Do not start new substantive work")
})

test("system reminder tells the model to use todowrite without treating it as goal completion", () => {
  const reminder = systemReminder()
  expect(reminder).toContain("todowrite")
  expect(reminder).toContain("Do not paste the full objective into a todo")
  expect(reminder).toContain("Completing every todo does not complete the goal")
})
