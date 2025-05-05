# USAGE
define USAGE
Usage: make [help | install |  TF_LOCK_ID=<TF_LOCK_ID> unlock | lint | fmt | plan env=[environment] | apply env=[environment] | destroy env=[environment]]
endef
export USAGE

TF_DIR := ./terraform
UNAME := $(shell uname -s)

help:
	@echo "$$USAGE"

install:
	tfenv install
	tgenv install 0.67.4

bootstrap: install init plan

lint:
	./scripts/lint.sh

fmt:
	./scripts/fmt.sh

login:
	gcloud auth application-default login

init:
	./scripts/init.sh $(env)

plan: init
	./scripts/plan.sh $(env)

apply:
	./scripts/apply.sh $(env)

unlock:
	./scripts/unlock.sh $(env)

destroy:
	./scripts/destroy.sh $(env)
