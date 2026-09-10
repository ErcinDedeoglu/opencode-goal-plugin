import { expect, test } from "bun:test"
import { extractGoalCommandArguments, parseGoalCommandAction, goalWorkPrompt } from "../src/goal-command"
import type { GoalSnapshot } from "../src/state"

const goal = {
  sessionID: "ses_1",
  objective: "how is weather in dubai and ankara",
  status: "active",
} as GoalSnapshot

test("parseGoalCommandAction creates from raw /goal text and delegates subcommands", () => {
  expect(parseGoalCommandAction("how is weather in dubai and ankara")).toEqual({
    type: "create",
    objective: "how is weather in dubai and ankara",
  })
  expect(parseGoalCommandAction("  ship it  ")).toEqual({ type: "create", objective: "ship it" })
  expect(parseGoalCommandAction("")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("status")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("history")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("clear")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("pause")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("resume")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("edit new objective")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("complete with evidence")).toEqual({ type: "delegate" })
  expect(parseGoalCommandAction("unmet blocked on keys")).toEqual({ type: "delegate" })
})

test("extractGoalCommandArguments reads the command XML block", () => {
  const text = `OpenCode goal mode command "/goal" was invoked.

Arguments:
<goal_command_arguments>
how is weather in dubai and ankara
</goal_command_arguments>
`
  expect(extractGoalCommandArguments(text)?.trim()).toBe("how is weather in dubai and ankara")
  expect(extractGoalCommandArguments("no block")).toBeUndefined()
})

test("goalWorkPrompt forbids rewriting a stored /goal objective", () => {
  const created = goalWorkPrompt("goal", goal, "created")
  expect(created).toContain("already stored this exact user-provided objective")
  expect(created).toContain("how is weather in dubai and ankara")
  expect(created).toContain("Do not call create_goal")
  expect(created).not.toContain("call create_goal once")
  expect(goalWorkPrompt("goal", goal, "conflict")).toContain("A different non-closed goal already exists")
})
