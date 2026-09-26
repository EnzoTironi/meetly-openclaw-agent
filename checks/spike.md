# Spike records

## Blocker found in code review (cloud, 2026-09-26): `plow_start_thread` in a cron turn

Source: `plow-openclaw-agent` @ `1e73c82`, `plugin/index.ts`.

- `plow_start_thread` looks up the current turn with
  `activeTurns.get(context.sessionKey)`, then does
  `if (!turn) throw new Error("Starting a thread requires an active message")`.
- `activeTurns` is only filled in `receive()`, the handler for an **inbound
  Plow message**, and cleared when that turn ends.
- The `meetly-poll` cron runs an isolated agent turn with no inbound Plow
  message. So `plow_start_thread` throws there, and the inbound flow (spec
  §2.2 step 5.4) cannot open the group as designed.
- Not affected: the owner request (§2.3) and group turns (§2.4) run inside
  inbound Plow messages. `message send` also works outside a turn: `send()`
  does not need one, and target `plow-owner` resolves the owner's DM.

Options:

1. **Script that calls the API `plow_start_thread` uses.** Add a
   `start-thread.ts` that does the same call:
   `POST {PLOW_API_BASE}/v1/chats`, with the bearer `PLOW_AGENT_TOKEN` and
   `{ line_uid, members: [owner provider_key, phone], body, trusted: true, idempotency_key }`.
   It takes `line_uid` and the owner's `provider_key` from `/v1/agents/me`,
   like `owner-chat.ts`. This keeps "don't wait for me", but it copies base
   plugin behaviour that could change under us, and it has no delivery-state
   tracking. An uncertain result is treated as "uncertain delivery"
   (§6: record without `chatUid`, never resend).
2. **The poll asks the owner first.** The poll DMs the owner "X wants to set
   up Y; reply ok and I'll open the group". The owner's reply is an inbound
   message, so `plow_start_thread` works in that turn. This breaks the
   decision "create the group automatically, notify the owner afterward".
3. **Change the base image** so a cron turn can start threads (upstream
   `plow-openclaw-agent`). This is outside this repo; the no-fork rule
   applies.

Still to confirm in [LOCAL] L1 §3 whatever is chosen: the tools a cron turn
can see, and whether `exec` gets `PLOW_API_BASE`/`PLOW_AGENT_TOKEN`.
