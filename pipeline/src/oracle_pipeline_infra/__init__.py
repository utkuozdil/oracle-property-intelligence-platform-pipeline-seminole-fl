"""Python CDK app that owns the Glue tier.

This is a second, separate CDK app in this repository. The TypeScript app under
``apps/api/cdk`` owns the serving and orchestration tiers; this app owns the Glue jobs.
The split follows the CDK rule that infrastructure is authored in the same language as
the service it deploys — a Python pipeline gets a Python CDK app.

The two apps share nothing but SSM parameter names, which the TypeScript app writes and
this app reads at deploy time.
"""

from oracle_pipeline_infra.app import main

__all__ = ["main"]
