# Meetly: a scheduling variant of Plow's OpenClaw base image.
# Pinned by digest: the base boots holding this agent's Plow credential.
# To bump, take a newer base-<sha> tag and its digest from
# https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents
FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-fba9c7ebba9a2623a56c6aba67993fc5cf8c1337@sha256:41b4b99f86d4cbdd554962b0b3fb1f014d0590a00688b57737209657589931ce

# Every Meetly group is trusted: a guest's reply must reach the ledger and
# calendar scripts; untrusted guests get replies only. The
# base's default ("ask") would also have the model ask the owner which kind
# of group to open. AGENTS.md limits what a guest can have done.
ENV AGENT_ID=meetly \
    AGENT_NAME=Meetly \
    AGENT_BLURB="Your scheduling assistant. It reads your iMessages, spots who wants to meet, and opens a group to book it on your calendar. Or ask it to reach out to anyone for you. Works both ways." \
    AGENT_RUNTIME="OpenClaw 2.0" \
    PLOW_THREAD_TRUST=trusted

COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/

# Meetly's entrypoint: the base's boot step for step, plus the model (Plow's
# Luna by default, the owner's own OpenAI account after `plow-llm openai`),
# the setup gate plugin and the Mac relay's request timeout.
COPY boot/ /opt/meetly/boot/
COPY plugin/ /opt/meetly/plugin/
COPY boot/plow-llm.sh /usr/local/bin/plow-llm

CMD ["node", "/opt/meetly/boot/preboot.ts"]
