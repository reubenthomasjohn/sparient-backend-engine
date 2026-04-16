# One ECR repo per Lambda. Keep last 5 images to cap storage costs.

variable "name_prefix" { type = string }

variable "repo_names" {
  type    = list(string)
  default = ["sparient-api", "sparient-discovery", "sparient-course-workflow", "sparient-responses"]
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(var.repo_names)
  name                 = each.key
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

output "repo_urls" {
  value = { for name, r in aws_ecr_repository.this : name => r.repository_url }
}
