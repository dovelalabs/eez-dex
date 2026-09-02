# The UP-1 external deployment bundle — RD-2 HX-1.
#
# A layer on the framework's own deploy image: the same Foundry, the same
# `scripts/deploy.sh`, plus this repository's compiled artifacts and the script
# that deploys them. Building *from* the framework's image rather than beside
# it is what keeps the six-env-vars-in / one-artifact-out contract intact — the
# framework's protocol bindings are still written by the framework's own code,
# and the DEX's ride alongside them.
#
# `MockPool` is frozen in `contracts/test/mocks/`. It is packaged here, never
# forked: what lands in the image is the artifact `forge build` produced from
# that file.
#
# Build it with `scenario/bundle/build.sh`, which compiles the contracts and
# exports the artifacts first. The base image is built by the framework's
# `testing/kurtosis/start.sh`; a remote Kurtosis run builds nothing, so both
# images must exist locally or in a registry the enclave can pull from (UP-3).

ARG EEZ_DEPLOY_IMAGE=eez-deploy:ci
FROM ${EEZ_DEPLOY_IMAGE}

# Compiled artifacts only — no sources, no Foundry project. The deploy script
# reads creation code out of them with `jq` and sends it with `cast`, so the
# image needs nothing this base does not already have.
COPY artifacts /dex/artifacts
COPY deploy-dex.sh /dex/deploy-dex.sh
COPY accounts.env /dex/accounts.env

# The Kurtosis step runs `eez.deploy_cmd`, not this; the entrypoint is here so
# the image is runnable by hand for debugging.
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["mkdir -p /out && bash /repo/scripts/deploy.sh && bash /dex/deploy-dex.sh"]
