---
name: grill-ship
description: Run the whole grill, build, review, merge, push, clean-up loop on a plan or task. Use when the user types /grill-ship.
disable-model-invocation: true
---

Call the Skill tool with "grilling" on the topic the user gave. Do not wait for the user's answers: answer every grilling question yourself with your recommended answer and keep going. Only stop for a decision that truly can't be made without the user (missing credentials, an irreversible choice with no sensible default).

Then run this sequence without pausing between steps, plus any extra instructions in the user's arguments:

1. **Implement.** Build the agreed result on a branch or worktree off `main`, following any git workflow in the project's CLAUDE.md. Verify with the project's build and tests.
2. **Self-review.** Review your own diff critically: bugs, gaps against the grilled decisions, simplification, missing tests or docs. List the changes you would suggest.
3. **Apply.** Implement those changes, then re-run the build and tests.
4. **Merge and push.** Merge into `main` (a `--no-ff` merge commit unless the project says otherwise), confirm the build passes on `main`, then push `main`.
5. **Clean up.** Delete the local branch, any remote branch you pushed, and any worktree you created. Leave other people's or other sessions' branches and worktrees alone. Confirm `git branch` and `git worktree list` show nothing left from this work.
6. **Archive.** Once steps 1 to 5 all succeeded, archive this session: load `mcp__ccd_session_mgmt__archive_session` through ToolSearch if it is deferred, then call it on the current session (get its id from `mcp__ccd_session_mgmt__get_session` or the "Linked sessions" note). Send the final summary first, since the session becomes read-only. Skip archiving if you stopped early or anything is left unfinished.

Stop and report instead of continuing if the merge conflicts, the build or tests fail on `main`, or a push is rejected. Never open a pull request. End with a short summary: what was decided, what was built, what the review changed, and confirmation that main is pushed and the branches are gone. Archive the session after that summary.
