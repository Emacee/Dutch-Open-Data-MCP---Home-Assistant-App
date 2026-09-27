# Built on the official Home Assistant base image (Alpine + s6-overlay + bashio).
# BUILD_FROM is supplied by the Supervisor from build.yaml.
ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# node/npm + git (npm needs it to fetch the nl-gov-mcp dependency straight
# from its GitHub repo, pinned by commit) + jq (run.sh uses it to merge the
# generated bearer token into options.json before pushing it back through
# the Supervisor API).
#
# apk installs whatever Node the base image's Alpine ships and npm treats
# package.json "engines" as advisory, so nothing would notice if that drifted
# below the >=22 nl-gov-mcp requires — which is exactly how this add-on ended
# up running on Node 20 unnoticed. The check below makes the version visible
# in the build log. It deliberately does NOT fail the build: the Alpine->Node
# mapping could not be verified ahead of this change, and a failed build would
# block installing the add-on entirely, which is worse than running on an
# older Node (which did work). gateway.mjs logs the same check at runtime.
RUN apk add --no-cache nodejs npm git jq \
    && node -e 'const v=process.versions.node, m=Number(v.split(".")[0]); console.log(m<22 ? `WARNING: base image ships Node ${v}; nl-gov-mcp asks for >=22. Bump build_from in build.yaml.` : `Node ${v} satisfies >=22`)'

WORKDIR /app

COPY app/package.json app/package-lock.json* /app/
# Full install first: the nl-gov-mcp git dependency runs its own "prepare"
# (tsc build) on install, which needs its devDependencies (typescript) present.
# Prune them away afterwards to keep the image small.
RUN npm install && npm prune --omit=dev && npm cache clean --force

# Glob, not a single named file: gateway.mjs imports sibling modules
# (oauth.mjs, …), and naming just one here silently ships a broken image
# that crash-loops on ERR_MODULE_NOT_FOUND the moment a module is added.
COPY app/*.mjs /app/

COPY run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 8098 8099
CMD [ "/run.sh" ]
