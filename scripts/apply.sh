#!/bin/bash

set -euo pipefail

# change to parent directory of this script so the context is correct
cd $(dirname $(dirname "$0"))

# interpret first argument as environment to set working directory
terragrunt_environment=$1

TF_CLI_ARGS=${TF_CLI_ARGS:-}
TF_LOG=${TF_LOG:-info}

terragrunt apply ${TF_CLI_ARGS} tfplan.binary \
        --terragrunt-log-level ${TF_LOG} --terragrunt-no-auto-init --terragrunt-working-dir=environments/$terragrunt_environment
