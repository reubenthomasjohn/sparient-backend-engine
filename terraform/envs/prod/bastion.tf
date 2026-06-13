# SSM bastion — a keyless jump host for reaching the private RDS Proxy from a local DB
# client (TablePlus / DBeaver / psql) via SSM port-forwarding. No SSH keys, no public IP,
# no inbound ports. Gated on var.create_bastion (on by default, ~$3/mo for the t4g.nano).
#
# Turn off:  set create_bastion = false (tfvars or -var) and `terraform apply` (destroys it).
# Turn back on: set it true again and `terraform apply`.
#
# Usage once it's up (see terraform/README.md for the full walkthrough):
#   aws ssm start-session --target $(terraform output -raw bastion_instance_id) \
#     --document-name AWS-StartPortForwardingSessionToRemoteHost \
#     --parameters '{"host":["'$(terraform output -raw db_proxy_endpoint)'"],
#                    "portNumber":["5432"],"localPortNumber":["5432"]}' \
#     --region us-west-2 --profile sparient

# Latest Amazon Linux 2023 arm64 AMI (SSM agent is preinstalled).
data "aws_ssm_parameter" "al2023_arm64" {
  count = var.create_bastion ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_iam_policy_document" "bastion_assume" {
  count = var.create_bastion ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "bastion" {
  count              = var.create_bastion ? 1 : 0
  name               = "${var.name_prefix}-bastion"
  assume_role_policy = data.aws_iam_policy_document.bastion_assume[0].json
}

# SSM core only — enough for Session Manager + port forwarding, nothing else.
resource "aws_iam_role_policy_attachment" "bastion_ssm" {
  count      = var.create_bastion ? 1 : 0
  role       = aws_iam_role.bastion[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "bastion" {
  count = var.create_bastion ? 1 : 0
  name  = "${var.name_prefix}-bastion"
  role  = aws_iam_role.bastion[0].name
}

# t4g.nano in a private subnet, in the shared Lambda SG (which the RDS Proxy already
# allows on 5432). SSM reaches it outbound via the NAT — no inbound rules needed.
resource "aws_instance" "bastion" {
  count                  = var.create_bastion ? 1 : 0
  ami                    = data.aws_ssm_parameter.al2023_arm64[0].value
  instance_type          = "t4g.nano"
  subnet_id              = module.networking.private_subnet_ids[0]
  vpc_security_group_ids = [aws_security_group.lambda.id]
  iam_instance_profile   = aws_iam_instance_profile.bastion[0].name

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  lifecycle {
    # The SSM parameter resolves to the *latest* AL2023 AMI on every plan; without this,
    # each new AMI release would replace the bastion (new instance id, dropped tunnels).
    ignore_changes = [ami]
  }

  tags = { Name = "${var.name_prefix}-bastion" }
}

output "bastion_instance_id" {
  value = var.create_bastion ? aws_instance.bastion[0].id : null
}
