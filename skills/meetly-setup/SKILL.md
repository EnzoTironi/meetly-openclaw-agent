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
     The default account's primary calendar is added automatically (by the
     account's address, the id `plow-gog calendar events` accepts), because
     holds go there.
3. On a script error, say the problem in one line and ask again.
4. When the output has `next: null`, run `record-setup.ts --done`. Then
   confirm in one or two lines that Meetly is on: days, window, duration,
   horizon. If `--done` fails, show its error line.

Never skip a question, invent an answer or fill one in from a guess.

## What setup fills by itself

`setup-status.ts` answers two questions before they are asked: the owner's
name, from their Plow profile, and their time zone, from their Mac
(`readlink /etc/localtime` through Latch, read-only). Neither is announced;
setup simply moves on. When `next` is still `ownerName` or `timezone`, that
source had no answer (no name on Plow, the Mac not connected): ask the owner.

## When the Mac is not connected

Meetly reads the owner's iMessages and Google Calendar on their Mac through
Plow Latch. At the time zone and calendars questions, `setup-status.ts` also
returns `mac`. When `mac.connected` is false, tell the owner that in one or
two lines and give them `mac.download` (where to get Plow Latch) and
`mac.about`. Still ask the time zone; do not ask the calendars question until
the Mac is connected, since it is answered from the Mac. Never ask the owner
to install anything else.

## After setup

- Change a setting ("change my window to 10-17", "call me Jean") →
  `record-setup.ts --field <field> --value <v>`, with the same normalization,
  then confirm in one line. During setup the owner can change the name the
  same way before answering the current question.
- "Pause Meetly" → `register-crons.ts --pause`. "Resume" → `register-crons.ts --resume`.
- "Status" → summarize `setup-status.ts`: days, window, duration, horizon,
  calendars, and whether it is paused.
