// Meetly's setup gate. Before each of the owner's own DM turns it runs
// setup-status.ts and hands the model the answer, so the turn starts from what
// setup needs now instead of from whatever the chat history last asked. The
// prompt keeps "run setup-status.ts first" as the fallback: nothing is added
// when the script cannot run, and the model then runs it itself.
//
// Plain JavaScript on purpose: the image ships it as is, with no build step,
// and preboot copies it into the state volume's plugin root on every boot.
import { execFile } from "node:child_process";

export const OWNER_DM_SESSION = "agent:main:main";
export const SETUP_STATUS = "/opt/plow/skills/meetly/scripts/setup-status.ts";

/** The owner's phone DM as the hook sees it: the Plow chat account, the owner's session, a user turn. */
export function isOwnerDmTurn(ctx) {
  return ctx?.channel === "plow" && (ctx.accountId ?? "chat") === "chat" &&
    ctx.sessionKey === OWNER_DM_SESSION && (ctx.trigger === undefined || ctx.trigger === "user");
}

/** What the model is told this turn, from setup-status.ts's JSON line; undefined when that is not a status. */
export function gateContext(stdout) {
  let status;
  try {
    status = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    return undefined;
  }
  if (status?.status === "READY") {
    return [
      "Meetly setup check, already run for this turn (setup-status.ts): READY.",
      "Do not run setup-status.ts again this turn. Handle the owner's message as \"How Meetly works\" says.",
      `setup-status.ts output: ${JSON.stringify(status)}`,
    ].join("\n");
  }
  if (status?.status !== "SETUP_NEEDED") return undefined;
  const name = status.draft?.ownerName;
  return [
    "Meetly setup check, already run for this turn (setup-status.ts): SETUP_NEEDED. Setup is not finished.",
    "Do not run setup-status.ts again this turn, and ignore any earlier setup question in the chat: this is the current state.",
    "Your reply, in the owner's language:",
    "- If you have not introduced yourself in this conversation yet, open with one line: you are Meetly, their AI scheduling assistant, and a few questions set you up.",
    ...(name ? [`- In that line, say you will refer to them as ${name} when you talk to other people, and that they can change it.`] : []),
    "- If the owner asked for something else, such as reaching someone, say you will do it once setup is done.",
    status.next === "timezone"
      ? "- Do not ask the time zone: read it from the owner's Mac as meetly-setup \"Time zone from the Mac\" says, record it without mentioning it to the owner, and ask the question record-setup.ts returns. Ask the owner only if the Mac cannot answer."
      : status.question
        ? `- Then ask this question, translated into the owner's language, and end the turn: ${status.question}`
        : "- Every answer is in: run record-setup.ts --done and confirm that Meetly is on, as meetly-setup says.",
    `If the owner's message answers ${status.next ? `the ${status.next} question` : "a question"}, record it first with record-setup.ts (see meetly-setup) and ask the question it returns instead.`,
    `setup-status.ts output: ${JSON.stringify(status)}`,
  ].join("\n");
}

const runStatus = () => new Promise((resolve, reject) => {
  execFile(process.execPath, [SETUP_STATUS], { env: process.env, timeout: 15_000, maxBuffer: 65_536 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

export default {
  id: "meetly",
  name: "Meetly",
  description: "Runs Meetly's setup check before each of the owner's DM turns.",
  register(api) {
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!isOwnerDmTurn(ctx)) return undefined;
      let context;
      try {
        context = gateContext(await runStatus());
      } catch (error) {
        api.logger.info(`meetly setup gate unavailable (${error instanceof Error ? error.message : String(error)}); prompt fallback applies`);
        return undefined;
      }
      // One line per owner turn, so a live run shows the gate reached the prompt.
      api.logger.info(context ? `meetly setup gate prepended: ${context.split("\n")[0]}` : "meetly setup gate: unreadable status; prompt fallback applies");
      return context ? { prependContext: context } : undefined;
    });
  },
};
