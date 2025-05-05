#!/bin/bash

set -euo pipefail

# change to parent directory of this script so the context is correct
cd $(dirname $(dirname "$0"))

# interpret first argument as environment to set working directory
terragrunt_environment=$1

TF_CLI_ARGS=${TF_CLI_ARGS:-}

TF_LOG=${TF_LOG:-info}

terragrunt plan ${TF_CLI_ARGS} --terragrunt-log-level ${TF_LOG} -out=tfplan.binary --terragrunt-working-dir=environments/$terragrunt_environment
