"""Synthetic decorated commands, matched after the "@"."""


@cli.command("wave")
def wave():
    return 3
