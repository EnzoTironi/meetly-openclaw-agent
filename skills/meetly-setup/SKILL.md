---
name: meetly-setup
description: Meetly's first-run questions in the owner's DM, and changing settings, pausing or resuming afterwards.
---
# Meetly setup

Only in the owner's DM. Never ask setup questions anywhere else.

## First run

1. Ask the `question` that `setup-status.ts` returns on this turn, translated
   into the owner's language, one per message, then end the turn. A question asked
   earlier in the chat is not the current one: always run the script and ask
   what it returns now. The first setup message opens with one line saying you
   are Meetly, their AI scheduling assistant, and that a few questions set you
   up. `setup-status.ts` takes the owner's name from their Plow profile; when
   `draft.ownerName` is set, that line also says the name you will use for
   them with other people and that they can change it. If the owner asked for
   something else, such as reaching someone, say in that line that you will do
   it once setup is done.
   Never ask the time zone while the Mac can answer it: when `next` is
   `timezone`, follow "Time zone from the Mac" below instead of asking.
2. When the owner answers, normalize the answer and run
   `node /opt/plow/skills/meetly/scripts/record-setup.ts --field <next> --value <v>`:
   - `ownerName` → the name as they gave it.
   - `timezone` → an IANA name, like `America/Sao_Paulo`.
   - `days` → a comma list like `mon,tue,wed`; "weekdays" means `mon,tue,wed,thu,fri`.
   - `window` → `HH:MM-HH:MM`.
   - `durationMin`, `horizonDays` → whole numbers.
   - `calendars` → before asking, run `plow-gog accounts` and
     `plow-gog calendar calendars` on the Mac (follow the Mac's
     `google-workspace` skill for the exact commands). Show the calendars with
     `selected: true` and suggest them. Record the JSON
     `{"defaultAccount": "<default account>", "calendars": [{"account": "…", "id": "…"}]}`.
     The default account's `primary` calendar is added automatically, because
     holds go there.
3. On a script error, say the problem in one line and ask again.
4. When the output has `next: null`, run `record-setup.ts --done`. Then
   confirm in one or two lines that Meetly is on: days, window, duration,
   horizon. If `--done` fails, show its error line.

Never skip a question, invent an answer or fill one in from a guess.

## Time zone from the Mac

The owner's time zone is read from their Mac, the way The Founder Times reads
it, never guessed from the chat and never asked while the Mac can answer.

1. `plow_browser_open` scoped to `["ipapi.co", "ipwho.is", "ifconfig.co"]`
   on the owner's Mac (the MCP server `plow`, so the tools are named
   `plow__plow_browser_open` and so on).
2. `plow_browser` `goto` `https://ipapi.co/json/`. Only if that `goto` itself
   errors (DNS failure, timeout, connection refused), `goto`
   `https://ipwho.is/`, then `https://ifconfig.co/json`. Stop after these
   three.
3. `plow_browser` `text` to read the JSON body of the one that loaded. The
   IANA zone is `timezone` on ipapi.co, `timezone.id` on ipwho.is and
   `time_zone` on ifconfig.co, like `America/Sao_Paulo`.
4. `plow_browser_close`.
5. Record it with `record-setup.ts --field timezone --value <zone>` and, in
   the same reply, ask the question `record-setup.ts` returns. Do not tell the
   owner which zone you found.

Never fetch it from the container, whose address is not the owner's. Only
when the Mac is not connected, or no provider gives a valid zone, ask the
owner the `timezone` question.

## After setup

- Change a setting ("change my window to 10-17", "call me Jean") →
  `record-setup.ts --field <field> --value <v>`, with the same normalization,
  then confirm in one line. During setup the owner can change the name the
  same way before answering the current question.
- "Pause Meetly" → `register-crons.ts --pause`. "Resume" → `register-crons.ts --resume`.
- "Status" → summarize `setup-status.ts`: days, window, duration, horizon,
  calendars, and whether it is paused.
