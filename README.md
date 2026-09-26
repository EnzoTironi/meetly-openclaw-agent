# Meetly

Meetly is an OpenClaw agent on Plow that books meetings for its owner.

- **Inbound.** Every 5 minutes it reads the owner's new iMessages through
  Latch. When someone wants to meet, it opens a Plow group with that person and
  the owner, offers three free times from the owner's Google Calendar (held as
  tentative events), and books the one they pick. It tells the owner
  afterwards.
- **Owner request.** The owner can ask in their DM ("set up lunch with Patrick
  next week, you can override Weekly Claw"). Meetly finds the contact, keeps to
  the request's constraints, and runs the same group conversation.

It always speaks as the owner's assistant, in the third person ("Jean is free
Tue 29/9 at 12:00"). Times are offered only inside the owner's days and hours.
A time outside them waits for the owner's yes.

Meetly is a variant of the
[Plow OpenClaw base image](https://github.com/plow-pbc/plow-openclaw-agent):
the `Dockerfile` is a `FROM` pinned by digest, plus `prompt/AGENTS.md` and
`skills/`. The base's `boot/` and `plugin/` are not forked.

## Setup conversation

After deploying, text the agent's line as the owner. Meetly asks, one message
at a time:

1. the name to use for you with other people
2. your time zone
3. the days it can book
4. the hours on those days
5. the default meeting length
6. how many days ahead to offer
7. which calendars count as busy (it lists them from your Mac)

Then it registers its `meetly-poll` cron job and confirms. Afterwards you can
say "change my hours to 10-17", "pause Meetly", "resume" or "status".

Meetly needs Latch running on your Mac, with the `plow-messages`, `contacts`
and `google-workspace` skills.

## Run locally

```sh
plow-agents mint LINE_UID      # writes ./plow-credentials
docker compose up --build
```

Open <http://localhost:3001>, then text the line as the owner. The base image
is published for `linux/amd64` only, so on Apple Silicon it runs emulated.
`docker compose down -v` deletes the state volume.

## Deploy

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

Deploy by the full digest that `push` prints.

## Bumping the base image

Pick a newer `base-<sha>` tag and its digest from
<https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents>, and update the `FROM` line
in `Dockerfile`. Then:

1. Copy that commit's `prompt/AGENTS.md` over `tests/fixtures/base-AGENTS.md`.
2. Re-apply the `## Meetly` section at the end of `prompt/AGENTS.md`.
3. Re-check `compose.yml` and `dev/Caddyfile` against the base.
4. Re-read `plugin/index.ts` for `plow_start_thread`. `start-thread.ts`
   mirrors its `POST /v1/chats` for the poll, which has no inbound message.
5. Run `npm test`.

## State

State lives in `/var/lib/plow/meetly` on the state volume, so it survives
restarts and rebuilds:

- `config.json`: the setup answers
- `cursor.json`: the last iMessage row read
- `ledger.json`: every request, with its offered times and hold ids

Meetly only deletes calendar events whose ids its ledger records as its own
holds.

## Development

```sh
npm install
npm run typecheck
npm test
```

Scripts are TypeScript run directly by Node ≥ 24.16, with no build step.
`checks/manual-scenarios.md` is the end-to-end checklist, and
`checks/spike.md` records findings from the owner's Mac.
