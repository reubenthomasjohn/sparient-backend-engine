# Build + push Lambda images to ECR.
# Requires: AWS_REGION, AWS_ACCOUNT_ID env vars (or pass on the make command line).
# Usage:
#   make ecr-login
#   make build-api build-discovery build-upload push-all

AWS_REGION     ?= us-east-2
AWS_ACCOUNT_ID ?= $(shell aws sts get-caller-identity --query Account --output text)
ECR_BASE       := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
PLATFORM       := linux/arm64

.PHONY: ecr-login build-api build-discovery build-upload push-api push-discovery push-upload push-all build-all

ecr-login:
	aws ecr get-login-password --region $(AWS_REGION) | \
		docker login --username AWS --password-stdin $(ECR_BASE)

build-api:
	docker build -f Dockerfile.lambda \
		--platform $(PLATFORM) \
		--build-arg LAMBDA_ENTRY=workers/api/lambda \
		-t sparient-api:latest \
		-t $(ECR_BASE)/sparient-api:latest .

build-discovery:
	docker build -f Dockerfile.lambda \
		--platform $(PLATFORM) \
		--build-arg LAMBDA_ENTRY=workers/discovery/lambda \
		-t sparient-discovery:latest \
		-t $(ECR_BASE)/sparient-discovery:latest .

build-upload:
	docker build -f Dockerfile.lambda \
		--platform $(PLATFORM) \
		--build-arg LAMBDA_ENTRY=workers/upload/lambda \
		-t sparient-upload:latest \
		-t $(ECR_BASE)/sparient-upload:latest .

build-all: build-api build-discovery build-upload

push-api:       ; docker push $(ECR_BASE)/sparient-api:latest
push-discovery: ; docker push $(ECR_BASE)/sparient-discovery:latest
push-upload:    ; docker push $(ECR_BASE)/sparient-upload:latest
push-all: push-api push-discovery push-upload
