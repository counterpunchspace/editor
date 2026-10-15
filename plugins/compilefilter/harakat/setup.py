from setuptools import setup, find_packages

setup(
    name="counterpunch-harakat",
    version="0.1.17",
    description="Raise Arabic vowel marks to a per-master minimum height at compile time",
    author="Yanone",
    license="GPL-3.0-or-later",
    packages=find_packages(),
    python_requires=">=3.10",
    entry_points={
        "counterpunch_compilefilter_plugins": [
            "harakat = counterpunch_harakat:Harakat",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)",
    ],
)
