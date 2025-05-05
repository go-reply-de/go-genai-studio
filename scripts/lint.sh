#!/bin/bash

set -euo pipefail

# change to parent directory of this script so the context is correct
cd $(dirname $(dirname "$0"))

terraform fmt -check -recursive -diff
