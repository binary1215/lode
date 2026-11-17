"""Synthetic name -> handler map for the product graph tests."""


def run_build():
    return 1


def run_clean():
    return 2


HANDLERS = {"compile": run_build, "clean": run_clean}
