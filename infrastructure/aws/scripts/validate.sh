#!/usr/bin/env bash
set -euo pipefail

# Validate and test AWS Terraform IaC using ONLY pinned Docker images and local cache volumes.
# NEVER runs `terraform apply` and NEVER touches any AWS account.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
AWS_DIR="${REPO_ROOT}/infrastructure/aws"

TF_IMAGE="hashicorp/terraform:1.11.4"
TFLINT_IMAGE="ghcr.io/terraform-linters/tflint:v0.55.1"
CHECKOV_IMAGE="bridgecrew/checkov:3.2.390"

TF_CACHE_VOL="${NESTLY_TF_CACHE_VOL:-nestly-tf-plugin-cache}"
TFLINT_CACHE_VOL="${NESTLY_TFLINT_CACHE_VOL:-nestly-tflint-cache}"

SAVE_PLAN_SUMMARY=""
if [[ "${1:-}" == "--save-plan-summary" && -n "${2:-}" ]]; then
  SAVE_PLAN_SUMMARY="$2"
fi

docker volume create "${TF_CACHE_VOL}" >/dev/null
docker volume create "${TFLINT_CACHE_VOL}" >/dev/null

run_tf() {
  local workdir="$1"
  shift
  docker run --rm \
    -v "${REPO_ROOT}:/workspace" \
    -v "${TF_CACHE_VOL}:/plugin-cache" \
    -e TF_PLUGIN_CACHE_DIR=/plugin-cache \
    -w "/workspace/${workdir}" \
    "${TF_IMAGE}" "$@"
}

echo "[1/6] Formatting all Terraform files (terraform fmt -check)..."
run_tf "infrastructure/aws" fmt -check -recursive

echo "[2/6] Initializing (backend=false) and validating envs/dev..."
run_tf "infrastructure/aws/envs/dev" init -backend=false -input=false -lockfile=readonly
run_tf "infrastructure/aws/envs/dev" validate

echo "[3/6] Initializing and running TFLint across infrastructure/aws..."
docker run --rm \
  -v "${REPO_ROOT}:/workspace" \
  -v "${TFLINT_CACHE_VOL}:/tflint-cache" \
  -e TFLINT_PLUGIN_DIR=/tflint-cache \
  -w "/workspace/infrastructure/aws" \
  "${TFLINT_IMAGE}" --init --config=/workspace/infrastructure/aws/.tflint.hcl

docker run --rm \
  -v "${REPO_ROOT}:/workspace" \
  -v "${TFLINT_CACHE_VOL}:/tflint-cache" \
  -e TFLINT_PLUGIN_DIR=/tflint-cache \
  -w "/workspace/infrastructure/aws" \
  "${TFLINT_IMAGE}" --recursive --config=/workspace/infrastructure/aws/.tflint.hcl

echo "[4/6] Running Checkov static security scan..."
docker run --rm \
  -v "${REPO_ROOT}:/workspace" \
  -w "/workspace" \
  "${CHECKOV_IMAGE}" -d /workspace/infrastructure/aws --config-file /workspace/infrastructure/aws/.checkov.yaml

echo "[5/6] Running Terraform tests with mock AWS provider (envs/dev/tests)..."
run_tf "infrastructure/aws/envs/dev" test

echo "[6/6] Running offline Terraform plan against envs/offline-plan (zero AWS API calls)..."
run_tf "infrastructure/aws/envs/offline-plan" init -backend=false -input=false -lockfile=readonly
run_tf "infrastructure/aws/envs/offline-plan" validate
PLAN_OUTPUT="$(run_tf "infrastructure/aws/envs/offline-plan" plan -no-color -input=false -lock=false -var-file=offline.tfvars -out=/tmp/offline.tfplan)"
echo "${PLAN_OUTPUT}" | tail -n 30

if [[ -n "${SAVE_PLAN_SUMMARY}" ]]; then
  mkdir -p "$(dirname "${SAVE_PLAN_SUMMARY}")"
  echo "${PLAN_OUTPUT}" > "${SAVE_PLAN_SUMMARY}"
  echo "[validate.sh] Saved offline plan output to ${SAVE_PLAN_SUMMARY}"
fi

echo "All Terraform validation, lint, Checkov security scan, mock test, and offline plan checks passed!"
