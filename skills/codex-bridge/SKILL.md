---
name: codex-bridge
description: Read saved projects and conversations or delegate authorized work to the user's paired local Codex Desktop through the Codex Bridge plugin.
---

# Codex Bridge

Use this workflow when a user wants ChatGPT to inspect Codex Desktop conversations or send work to their paired computer.

1. Call `codex_bridge_status`. If unpaired or offline, direct the user to the local connector's pairing URL or ask them to start their installed connector. Never claim that an offline computer received work.
2. Call `list_codex_projects` or `list_codex_threads` to verify the exact saved project and destination. These calls return queue operation IDs. Use `read_codex_request` to retrieve their results before choosing a destination.
3. Create a new conversation with `start_codex_thread` only when the user explicitly or through standing instructions authorizes a new task. Supply the exact saved project path, a clear title, a complete English brief and a fresh UUID `requestId`. Structure briefs as Goal, Context, Task, Scope, Constraints, Done when and Reply format when useful. Preserve literal user text and file names.
4. Continue unfinished work in its verified original thread with `send_to_codex_thread`. Read that thread before sending if its identity or current work is uncertain. Supply a fresh UUID per distinct follow-up, retaining the same UUID only for a retry of that exact follow-up.
5. Use `read_codex_request` with the returned queue ID. A queued or claimed operation is not a completed Desktop action. The `result` of a completed operation can still indicate a blocked or uncertain Desktop action. Read the actual result before reporting success.
6. After a confirmed send, use `read_codex_thread` to inspect progress or replies. Desktop acceptance is separate from completion of the user's task.

Never automatically resend work after an uncertain, disconnected or expired claimed operation. Preserve its queue ID, request UUID and any confirmed thread ID. Inspect the original task. An `expired_not_dispatched` request was not taken by the connector. A disconnected computer does not imply that previously dispatched Desktop work stopped.

Each ChatGPT account controls only its paired computer. Local allowed roots, saved project identity and original signed-in account bindings are checked by the connector. Do not request a broader root, different account, arbitrary native operation or CLI fallback to bypass a rejection.
