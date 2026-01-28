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

from setuptools import setup, find_packages

setup(
    name="general-filter-plugin",
    version="0.1.0",
    description="General glyph filters: All Glyphs, Encoded Characters, Unencoded Glyphs",
    author="Yanone",
    license="GPL-3.0-or-later",
    
    packages=find_packages(),
    python_requires=">=3.10",
    
    entry_points={
        "context_glyph_filter_plugins": [
            "all_glyphs = general_filter_plugin:AllGlyphsFilter",
            "encoded_glyphs = general_filter_plugin:EncodedGlyphsFilter",
            "unencoded_glyphs = general_filter_plugin:UnencodedGlyphsFilter",
        ],
    },
    
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
)
