#!/usr/bin/env bash
set -euo pipefail

# Homebrew loads casks from taps. Trust only this temporary clone's cask on the
# disposable CI runner, then remove the tap after validating its metadata.
brew tap sim-relay-ci/validate "file://$PWD"
trap 'brew untap sim-relay-ci/validate' EXIT
brew trust --cask sim-relay-ci/validate/sim-relay
brew info --json=v2 --cask sim-relay-ci/validate/sim-relay
