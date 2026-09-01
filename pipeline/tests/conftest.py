"""Puts ``src/`` on the import path so the pure transform modules are testable locally.

The Glue job ships its library as ``--extra-py-files``, which unpacks ``src/`` onto the
runtime's path rather than installing a wheel. Injecting the same directory here means
tests import the modules exactly as the Glue runtime will, with no editable install and
no local Spark.
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
