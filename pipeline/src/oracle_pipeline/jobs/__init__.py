"""AWS Glue job entry points.

Each module in this package is uploaded to S3 as a Glue script asset by the Python CDK
app in ``oracle_pipeline_infra``. Modules here import ``awsglue`` and ``pyspark``, which
exist only inside the Glue runtime.
"""
