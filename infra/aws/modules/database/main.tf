# RDS for PostgreSQL 16 in private subnets, encrypted at rest and in transit, with automated backups and
# point-in-time recovery, and two layers of deletion protection (the instance's flag and prevent_destroy).
#
# The instance is reached on its private address with a password, over TLS. RDS has no IAM role for a direct
# connection, so none is granted; IAM database authentication is off.
#
# An RDS Proxy is optional and off by default. Transaction pooling disables session features (advisory locks,
# LISTEN/NOTIFY, prepared statements across transactions), and a client that uses one is pinned to a server
# connection, which erases the pooling. spike 05 decides: not the default until pinning is measured against
# this workload.

locals {
  proxy = var.proxy != null
}

resource "random_password" "database" {
  length  = 32
  special = false # the password travels in a URL, so it uses no character that needs escaping
}

resource "aws_db_subnet_group" "main" {
  name        = "${var.name}-pg"
  description = "Qelay-Cloud ${var.name}: private subnets"
  subnet_ids  = var.subnet_ids
  tags        = var.tags
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Qelay-Cloud database: PostgreSQL from the tasks (or the proxy), nothing else"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-database" })
}

resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  count = local.proxy ? 0 : length(var.client_security_group_ids)

  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.client_security_group_ids[count.index]
}

resource "aws_db_parameter_group" "main" {
  name        = "${var.name}-pg16"
  family      = "postgres16"
  description = "Qelay-Cloud ${var.name}: connection limit and TLS"
  tags        = var.tags

  # The budget module's number: a static parameter, so RDS applies it at the next reboot.
  parameter {
    name         = "max_connections"
    value        = tostring(var.max_connections)
    apply_method = "pending-reboot"
  }

  # The default from PostgreSQL 15, written down so a plaintext connection is refused whatever the default becomes.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${var.name}-pg"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.database_name
  username = var.user_name
  password = random_password.database.result

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb == 0 ? null : var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.storage_kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name
  ca_cert_identifier     = var.ca_cert_identifier

  backup_retention_period   = var.backup_retention_days
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-pg-final"

  deletion_protection                 = var.deletion_protection
  auto_minor_version_upgrade          = true
  apply_immediately                   = false
  iam_database_authentication_enabled = false
  performance_insights_enabled        = var.performance_insights
  tags                                = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

# --- the optional proxy ---------------------------------------------------------------------------------

# The proxy reads the database credential from a secret of its own, in the shape it requires.
resource "aws_secretsmanager_secret" "proxy" {
  count = local.proxy ? 1 : 0

  name                    = "${var.name}/database-proxy-auth"
  description             = "Qelay-Cloud ${var.name}: the credential the RDS Proxy connects with"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "proxy" {
  count = local.proxy ? 1 : 0

  secret_id = aws_secretsmanager_secret.proxy[0].id
  secret_string = jsonencode({
    username = var.user_name
    password = random_password.database.result
  })
}

resource "aws_iam_role" "proxy" {
  count = local.proxy ? 1 : 0

  name = "${var.name}-db-proxy"
  tags = var.tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "proxy" {
  count = local.proxy ? 1 : 0

  name = "read-the-proxy-credential"
  role = aws_iam_role.proxy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadTheCredential"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.proxy[0].arn]
      },
      {
        Sid      = "DecryptTheCredential"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [coalesce(var.secrets_kms_key_arn, "arn:${var.partition}:kms:${var.region}:${var.account_id}:key/*")]
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_security_group" "proxy" {
  count = local.proxy ? 1 : 0

  name        = "${var.name}-database-proxy"
  description = "Qelay-Cloud database proxy: PostgreSQL from the tasks, to the database"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-database-proxy" })
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_clients" {
  count = local.proxy ? length(var.client_security_group_ids) : 0

  security_group_id            = aws_security_group.proxy[0].id
  description                  = "PostgreSQL from the tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.client_security_group_ids[count.index]
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_database" {
  count = local.proxy ? 1 : 0

  security_group_id            = aws_security_group.proxy[0].id
  description                  = "PostgreSQL to the database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_proxy" {
  count = local.proxy ? 1 : 0

  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the proxy"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.proxy[0].id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_clients_direct" {
  # Behind a proxy the tasks still need the database directly for LISTEN (QCLOUD_DATABASE_LISTEN_URL).
  count = local.proxy ? length(var.client_security_group_ids) : 0

  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the tasks, for LISTEN, which cannot go through the proxy"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.client_security_group_ids[count.index]
}

resource "aws_db_proxy" "main" {
  count = local.proxy ? 1 : 0

  name                   = "${var.name}-proxy"
  engine_family          = "POSTGRESQL"
  require_tls            = true
  idle_client_timeout    = var.proxy.idle_client_timeout_seconds
  debug_logging          = false
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy[0].id]
  tags                   = var.tags

  auth {
    auth_scheme               = "SECRETS"
    client_password_auth_type = "POSTGRES_SCRAM_SHA_256"
    iam_auth                  = "DISABLED"
    secret_arn                = aws_secretsmanager_secret.proxy[0].arn
  }

  depends_on = [aws_secretsmanager_secret_version.proxy, aws_iam_role_policy.proxy]
}

resource "aws_db_proxy_default_target_group" "main" {
  count = local.proxy ? 1 : 0

  db_proxy_name = aws_db_proxy.main[0].name

  connection_pool_config {
    max_connections_percent      = var.proxy.max_connections_percent
    max_idle_connections_percent = var.proxy.max_idle_connections_percent
    connection_borrow_timeout    = var.proxy.borrow_timeout_seconds
  }
}

resource "aws_db_proxy_target" "main" {
  count = local.proxy ? 1 : 0

  db_proxy_name          = aws_db_proxy.main[0].name
  target_group_name      = aws_db_proxy_default_target_group.main[0].name
  db_instance_identifier = aws_db_instance.main.identifier
}
