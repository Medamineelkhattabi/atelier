"""run.origin: the owner's own work vs quality-check (evaluation) runs

Revision ID: 0003
Revises: 0002
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("runs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("origin", sa.String(length=16), nullable=False, server_default="owner"))
        batch_op.create_index(batch_op.f("ix_runs_origin"), ["origin"], unique=False)
    # Runs recorded by earlier quality checks (case runs and judge runs), with their whole tree.
    conn = op.get_bind()
    ids: set[str] = set()
    for (results,) in conn.execute(sa.text("SELECT results FROM eval_runs")):
        items = json.loads(results) if isinstance(results, str) else results
        for item in items or []:
            if not isinstance(item, dict):
                continue
            ids.update(str(v) for v in (item.get("run_id"),) if v)
            for check in item.get("checks") or []:
                if isinstance(check, dict) and check.get("judge_run_id"):
                    ids.add(str(check["judge_run_id"]))
    runs = sa.table("runs", sa.column("id"), sa.column("root_run_id"), sa.column("origin"))
    for chunk in [sorted(ids)[i : i + 400] for i in range(0, len(ids), 400)]:
        conn.execute(runs.update().where(runs.c.root_run_id.in_(chunk)).values(origin="quality_check"))


def downgrade() -> None:
    with op.batch_alter_table("runs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_runs_origin"))
        batch_op.drop_column("origin")
