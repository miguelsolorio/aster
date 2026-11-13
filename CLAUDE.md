# Git workflow

All new work happens in a git worktree on its own branch, never directly on `main`. This repo does not use pull requests.

1. Start: create a worktree and branch from `main`, for example `git worktree add .claude/worktrees/<name> -b <name> main`. Do all edits, builds, and commits there.
2. Finish: when the work is complete and verified, merge the branch into `main` from the main checkout with a merge commit (`git merge --no-ff <name>`, message "Merge <name> into main").
3. Clean up: remove the worktree (`git worktree remove`) and delete the branch (`git branch -d`), plus its remote branch if one was pushed. Nothing from the finished work should be left in `git worktree list` or `git branch`.

- Never open a PR, and never offer to.
- Only merge finished work. If the work is paused or abandoned, leave the worktree and say so instead of merging.
- Clean up only the worktrees and branches of the work you just merged. Other worktrees may belong to sessions still in progress; leave them alone unless Miguel asks.
- If the merge conflicts or the build fails on `main` after merging, stop and tell Miguel before going further.
- Subagents work inside the worktree you name in the brief. They do not commit, merge, or create branches; the orchestrator does that.

# Orchestration

The main session runs on Fable and acts as the orchestrator. You plan, split the work, hand each piece to the cheapest model that will do it well, check what comes back, and talk to Miguel. The goal is to get the most out of the plan's limits: the best model for each task, no tokens burned on work a smaller model does equally well, and no agent left spinning.

## Who does what

| Work | Model | Agent |
| --- | --- | --- |
| Planning, architecture, ambiguous debugging, judging results, final answer | Fable | you, in the main session |
| Hard implementation, subtle bugs, cross-file refactors, independent review of a risky change | Opus | `expert` |
| Well-specified implementation, tests, docs, copy, routine fixes | Sonnet | `builder` |
| Searching, reading and summarizing files or logs, mechanical renames, running a command and reporting | Haiku | `scout` |

The agents live in `.claude/agents/`. For a built-in agent (`Explore`, `general-purpose`), pass `model` on the call (`haiku`, `sonnet`, `opus`) using the same table.

- Do it yourself when it takes a handful of tool calls. A delegation costs a brief and a report, so it only pays off for real chunks of work.
- Pick the tier from the difficulty of the piece, not of the whole task. A hard feature still has easy parts.
- When unsure between two tiers, take the lower one and review the result. Escalate only on evidence that it fell short.
- Fable never goes to a subagent. If a piece needs Fable, do it yourself.

## Usage budget

Read the plan limits with `mcp__ccd_session_mgmt__get_usage` (load it through ToolSearch if it is deferred). It reports percent used for the 5-hour window, the weekly all-models window, and the weekly Fable window. Check it:

- at the start of any task that will involve delegation,
- before launching more than one agent at once,
- after each agent returns during long work.

Act on the highest of the three percentages:

| Used | What to do |
| --- | --- |
| Under 70% | Use the best model for each task. Do not ration. |
| 70 to 85% | Drop non-critical work one tier. At most two agents at once. |
| 85 to 90% | Start nothing new on Opus. Finish what is in flight and bring the work to a clean stopping point. |
| 90% or more | Stop starting work. Tell Miguel what is done, what is left, and when the window resets. |

90% is the ceiling, not a target to avoid: below it, unused budget is wasted budget, so prefer quality over thrift until the table says otherwise.

If only the weekly Fable window is near 90%, say so and suggest switching the main session to Opus; delegated work can continue.

If the usage tool is unavailable (for example in the terminal CLI), say that you cannot see the limits and ask Miguel for the numbers from `/usage` before any large fan-out. Never guess a percentage.

## Keeping agents from spinning

Each agent in `.claude/agents/` has a hard `maxTurns` cap. On top of that:

- Every brief states the goal, the files in scope, what done looks like, and a stop rule: "if the same error comes back twice, or you are not converging, stop and report what you tried."
- At most three agents at once. Agents do not spawn agents.
- Run agents in the background. If one is still going well past what its task should take, stop it and read what it has so far instead of waiting.
- An agent that hits its turn cap or reports failure gets one retry, with a narrower brief or one tier up. If that fails too, do the piece yourself or bring it to Miguel. Never send the same brief a third time.
- Do not re-run an agent to double-check a result you can verify with a test, a build, or a diff.
- Ask for short reports: the conclusion, the files changed, and anything unverified. No file dumps.
