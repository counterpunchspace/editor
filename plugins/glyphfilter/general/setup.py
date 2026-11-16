# Copyright (C) 2025 Yanone
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Setup script for General Glyph Filter Plugin
"""

import json
from pathlib import Path

from setuptools import setup, find_packages

# Writing script codes in writing_scripts.py: the table, Common and
# No Writing Script.
WRITING_SCRIPT_CODES = [
    code
    for code, _name in json.loads(
        (
            Path(__file__).parent / "general_filter_plugin" / "writing_scripts.json"
        ).read_text(encoding="utf-8")
    )
] + ["Zyyy", "Zzzz"]

# Category filters in unicode_categories.py, in sidebar order.
CATEGORY_KEYS = (
    "letters modifiers marks figures punctuation symbols spaces none"
).split()

setup(
    name="general-filter-plugin",
    version="0.1.0",
    description=(
        "General glyph filters: All Glyphs, Encoded Characters, "
        "Unencoded Glyphs, glyph categories, writing scripts"
    ),
    author="Yanone",
    license="GPL-3.0-or-later",
    packages=find_packages(),
    package_data={"general_filter_plugin": ["writing_scripts.json"]},
    python_requires=">=3.10",
    entry_points={
        "counterpunch_glyphfilter_plugins": [
            "all_glyphs = general_filter_plugin:AllGlyphsFilter",
            "auto_qa_issues = general_filter_plugin:AutoQaIssuesFilter",
            "encoded_glyphs = general_filter_plugin:EncodedGlyphsFilter",
            (
                "incompatible_outlines = "
                "general_filter_plugin:IncompatibleOutlinesFilter"
            ),
            "unencoded_glyphs = general_filter_plugin:UnencodedGlyphsFilter",
        ]
        + [
            (
                f"category_{key} = general_filter_plugin."
                f"unicode_categories:{key.capitalize()}CategoryFilter"
            )
            for key in CATEGORY_KEYS
        ]
        + [
            (
                f"script_{code} = general_filter_plugin."
                f"writing_scripts:{code}ScriptFilter"
            )
            for code in WRITING_SCRIPT_CODES
        ],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        (
            "License :: OSI Approved :: "
            "GNU General Public License v3 or later (GPLv3+)"
        ),
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
)
