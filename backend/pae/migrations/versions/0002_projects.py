"""projects, run.project_id, project-scoped secrets

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

from pae.db import UTCDateTime

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("workspace", sa.Text(), nullable=False),
        sa.Column("context", sa.Text(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("runs") as batch:
        batch.add_column(sa.Column("project_id", sa.String(length=64), nullable=True))
        batch.create_index("ix_runs_project_id", ["project_id"])
    # Secrets get a (name, project_id) key; existing secrets become global (project_id "").
    op.create_table(
        "secrets_new",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("project_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("hint", sa.String(length=16), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("name", "project_id"),
    )
    op.execute(
        "INSERT INTO secrets_new (name, project_id, ciphertext, hint, created_at, updated_at) "
        "SELECT name, '', ciphertext, hint, created_at, updated_at FROM secrets"
    )
    op.drop_table("secrets")
    op.rename_table("secrets_new", "secrets")


def downgrade() -> None:
    raise NotImplementedError("downgrade not supported")
