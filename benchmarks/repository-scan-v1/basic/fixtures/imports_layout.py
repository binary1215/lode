"""Parity cases: Python import lists over lines and continued lines."""

from .models import (
    Item,  # the item
    make_item as build,
)
from .other import alpha, \
    beta as gamma
from .single import (one, two)


class Store:
    @classmethod
    def make(cls):
        return cls()
