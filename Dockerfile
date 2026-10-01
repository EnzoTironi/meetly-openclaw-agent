# Meetly: a variant of Plow's OpenClaw base image (prompt + skills only).
# Pinned by digest: the base boots holding this agent's Plow credential.
# To bump, take a newer base-<sha> tag and its digest from
# https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents
# BASE_IMAGE is overridden only for local development on Apple Silicon
# (compose.arm64.yml, dev/build-base.sh); images you deploy use this default.
ARG BASE_IMAGE=public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-771198a9609dcef54d44843e7da5329c17fa51b4@sha256:f1e7c421b97a80f1bd17015f96daceb965f350a241f7edc7e4d856a0e3a6f8f5
FROM ${BASE_IMAGE}

# Every Meetly group is trusted: a guest's reply must reach the ledger and
# calendar scripts, and an untrusted group lets it only ask the owner. The
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

# The base image (pinned at base-771198a) bakes in an amd64-only agentsview,
# the collector the Agent Index reporter reads for token usage. On an arm64
# build -- the local dev base compose.arm64.yml points at -- that binary
# fails under Rosetta (missing ld-linux-x86-64.so.2) and every usage report
# reads a day of zeros. Reinstall it for the build's actual architecture, the
# same pinned-and-checksummed pattern aha and the-founder-times use in their
# own Dockerfiles. A no-op download-and-replace on the published amd64 base.
USER root
ARG AGENTSVIEW_VERSION=0.44.0
ARG AGENTSVIEW_SHA256_AMD64=037ea7a46d52e06b20363b4aa7cd7f28e32f31d8215803d6e9a0c96bac5818e3
ARG AGENTSVIEW_SHA256_ARM64=6f3c76ebe119826a2def1ae226c3573b214d396a3ed7c477ef282b1063345b87
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) sum="${AGENTSVIEW_SHA256_AMD64}" ;; \
      arm64) sum="${AGENTSVIEW_SHA256_ARM64}" ;; \
      *) echo "agentsview: no pinned build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsS --max-time 120 -L -o /tmp/agentsview.tgz \
      "https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_linux_${TARGETARCH:-amd64}.tar.gz" \
 && echo "${sum}  /tmp/agentsview.tgz" | sha256sum -c - \
 && tar -xzf /tmp/agentsview.tgz -C /usr/local/bin agentsview \
 && rm /tmp/agentsview.tgz \
 && chmod 0755 /usr/local/bin/agentsview
USER node

CMD ["node", "/opt/meetly/boot/preboot.ts"]
