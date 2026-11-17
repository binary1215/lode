"""Synthetic decorated commands for the product graph tests."""


@app.command("greet")
def greet():
    return 1


@app.command("leave")

@trace
def leave():
    return 2
