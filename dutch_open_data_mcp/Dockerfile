# Built on the official Home Assistant base image (Alpine + s6-overlay + bashio).
# BUILD_FROM is supplied by the Supervisor from build.yaml. Declared before the
# first FROM so both stages can use it.
ARG BUILD_FROM

# ---------------------------------------------------------------------------
# Build stage: everything needed only to fetch and compile dependencies.
# npm and git never reach the runtime image, so they are not part of what
# runs on your host — less to patch, less to exploit.
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM} AS build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# git: npm fetches nl-gov-mcp straight from its GitHub repo, pinned by commit.
RUN apk add --no-cache nodejs npm git

WORKDIR /app
COPY app/package.json app/package-lock.json /app/

# npm ci, not npm install: installs exactly what package-lock.json records —
# every transitive dependency at a fixed version and integrity hash — instead
# of resolving fresh on each user's machine, so every build is the same build
# and a newly published malicious version of some deep dependency can't slip
# in. --omit=dev is safe here: npm still installs nl-gov-mcp's own dev
# dependencies in a temporary directory to run its "prepare" (tsc) build, then
# discards them.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

ENV NODE_ENV=production

# jq: run.sh uses it to merge the generated bearer token into options.json
# before writing it back through the Supervisor API.
#
# apk installs whatever Node the base image's Alpine ships, and npm treats
# package.json "engines" as advisory, so nothing would notice if that drifted
# below the >=22 nl-gov-mcp requires. The check prints it in the build log
# (gateway.mjs repeats it at runtime). Non-fatal on purpose: a failed build
# blocks installing the add-on at all. Alpine 3.22 (build.yaml) ships 22.x.
RUN apk add --no-cache nodejs jq \
    && node -e 'const v=process.versions.node, m=Number(v.split(".")[0]); console.log(m<22 ? `WARNING: base image ships Node ${v}; nl-gov-mcp asks for >=22. Bump build_from in build.yaml.` : `Node ${v} satisfies >=22`)'

WORKDIR /app
# Pure-JS dependencies only (no native addons), so node_modules is portable
# between two stages built from the same base image.
COPY --from=build /app/node_modules /app/node_modules
COPY app/package.json /app/
# Glob, not a single named file: gateway.mjs imports sibling modules
# (oauth.mjs, …), and naming just one here silently ships a broken image
# that crash-loops on ERR_MODULE_NOT_FOUND the moment a module is added.
COPY app/*.mjs /app/

COPY run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 8098 8099
CMD [ "/run.sh" ]
