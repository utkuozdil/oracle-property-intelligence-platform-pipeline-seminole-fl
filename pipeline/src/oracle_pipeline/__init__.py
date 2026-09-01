"""PySpark / AWS Glue tier for the Oracle Seminole County pipeline.

This package is the one place Python is permitted in this repository: the engineering
guidelines allow Python for PySpark and AWS Glue jobs only. Everything outside
``pipeline/`` — APIs, Lambdas, Step Functions, and the serving-tier CDK — is TypeScript.
"""

from oracle_pipeline import manifests

__all__ = ["manifests"]
