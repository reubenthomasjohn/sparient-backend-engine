# RDS Postgres + RDS Proxy. Lambda workers connect to the proxy endpoint, not RDS directly,
# so connection churn from cold starts does not exhaust the DB's connection limit.
#
# Sized for dev: db.t4g.micro, single-AZ, 20 GB gp3, auto-generated password in SSM.
# Swap to Aurora later by replacing the aws_db_instance with aws_rds_cluster +
# aws_rds_cluster_instance — the outputs stay the same.

variable "name_prefix"  { type = string }
variable "vpc_id"       { type = string }
variable "subnet_ids"   { type = list(string) }
variable "lambda_sg_id" { type = string } # the shared Lambda SG that can reach the proxy

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "sparient"
}

variable "db_username" {
  type    = string
  default = "sparient"
}

resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "_-"
}

resource "aws_ssm_parameter" "db_password" {
  name  = "/${var.name_prefix}/db/password"
  type  = "SecureString"
  value = random_password.db.result
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db-subnets"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds-sg"
  description = "RDS Postgres — reachable only from RDS Proxy"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "proxy" {
  name        = "${var.name_prefix}-rds-proxy-sg"
  description = "RDS Proxy — reachable only from Lambda SG"
  vpc_id      = var.vpc_id
}

# Proxy → RDS
resource "aws_vpc_security_group_ingress_rule" "rds_from_proxy" {
  security_group_id            = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.proxy.id
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_rds" {
  security_group_id            = aws_security_group.proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.rds.id
}

# Lambda → Proxy
resource "aws_vpc_security_group_ingress_rule" "proxy_from_lambda" {
  security_group_id            = aws_security_group.proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = var.lambda_sg_id
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name_prefix}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "this" {
  identifier             = "${var.name_prefix}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.instance_class
  allocated_storage      = var.allocated_storage_gb
  storage_type           = "gp3"
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  skip_final_snapshot    = true # dev
  publicly_accessible    = false
  multi_az               = false
  backup_retention_period = 1
  apply_immediately      = true
}

# Proxy needs the DB credentials in Secrets Manager (RDS Proxy requirement —
# it does not read from SSM). This is the one line item in this module that
# costs money: $0.40/mo for the one secret.
resource "aws_secretsmanager_secret" "db_creds" {
  name                    = "${var.name_prefix}/db/proxy-credentials"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db_creds" {
  secret_id = aws_secretsmanager_secret.db_creds.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
  })
}

data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name               = "${var.name_prefix}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

data "aws_iam_policy_document" "proxy" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db_creds.arn]
  }
}

resource "aws_iam_role_policy" "proxy" {
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy.json
}

resource "aws_db_proxy" "this" {
  name                   = "${var.name_prefix}-db-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy.id]
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db_creds.arn
  }
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name
  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "this" {
  db_instance_identifier = aws_db_instance.this.id
  db_proxy_name          = aws_db_proxy.this.name
  target_group_name      = aws_db_proxy_default_target_group.this.name
}

output "proxy_endpoint"     { value = aws_db_proxy.this.endpoint }
output "db_name"            { value = var.db_name }
output "db_username"        { value = var.db_username }
output "db_password_param"  { value = aws_ssm_parameter.db_password.name }
output "rds_endpoint"       { value = aws_db_instance.this.endpoint } # for one-off migrations via bastion/SSM
