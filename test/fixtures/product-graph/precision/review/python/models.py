"""Synthetic Python models."""


class Item:
    @classmethod
    def make(cls):
        return cls()


def make_item():
    return Item()
