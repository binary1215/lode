"""Synthetic module with one call of each unresolved kind."""
from requests import get


def helper():
    return 1


def helper():
    return 2


def calls():
    helper()
    undefined_thing()
    get("https://example.invalid")
