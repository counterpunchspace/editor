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
Setup script for Base Canvas Plugin Template

Customize this file for your plugin:
1. Change 'name' to your plugin name (lowercase-with-hyphens)
2. Update 'description' with your plugin's purpose
3. Update 'author' with your name
4. Change the entry point name and target class
"""

from setuptools import setup, find_packages

setup(
    # Package identification
    name="base-canvas-plugin",  # Change this to your plugin name
    version="0.1.0",
    description="Minimal template for Context Font Editor canvas plugins",  # Change this
    author="Yanone",  # Change this to your name
    license="GPL-3.0-or-later",
    
    # Package contents
    packages=find_packages(),
    python_requires=">=3.10",
    
    # Entry point registration
    # Format: "plugin_id = package_name:ClassName"
    entry_points={
        "context_canvas_plugins": [
            "base = base_canvas_plugin:BaseCanvasPlugin",  # Change both parts
        ],
    },
    
    # PyPI classifiers
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
)
