# Plow owns boot, iMessage, Latch, model authentication and the Index client.
FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-cc708dd8534f9c7686be4223713570c16e5ad006@sha256:1cf8e57ec949f8077329927da47df4215620605cdd987bbd4bb36eaa5147da06

USER root
# Native extension installation and delivery helpers, proposed upstream.
# Remove this pinned patch when a published Plow base includes the commit.
ADD --checksum=sha256:e0ec1e53130ab30ccde3fe04aa9ef4ea272e2e7e8b0c8df9427ee2e451ef6a36 https://github.com/EnzoTironi/zoen-plow/commit/596954a68a4a593fd6380eafcdac471c89eca9cc.patch /tmp/plow-native.patch
RUN git -C /opt/plow apply --include='boot/*.ts' --include='plugin/*.ts' --include='build.ts' /tmp/plow-native.patch \
    && node /opt/plow/build.ts && rm /tmp/plow-native.patch

COPY package.json package-lock.json openclaw.plugin.json /opt/meetly/
COPY src/ /opt/meetly/src/
RUN cd /opt/meetly && npm ci --omit=dev --ignore-scripts
COPY agent.json /opt/plow/agent.json
COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/

# Private local installs do not register or report to the public leaderboard.
# Set AGENT_ID explicitly only when the owner chooses to publish a listing.
ENV AGENT_ID="" PLOW_THREAD_TRUST=untrusted
USER node
