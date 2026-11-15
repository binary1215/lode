"""Uses a parenthesised import list and the print built-in."""
from .models import (
    Item,
    make_item as build,
)


def use():
    print(build())
    return Item()
