"""Synthetic Python members for the call-precision tests."""


class Base:
    def ping(self):
        return 1


class Store(Base):
    def __init__(self, name):
        self.name = name

    def load(self, key):
        return self.decode(key) + self.ping()

    def decode(self, raw):
        return raw

    @staticmethod
    def create(name):
        return Store(name)


def use_all():
    store = Store.create("x")
    made = Store("y")
    made.load("k")
    later = Store("z")
    later = Store.create("w")
    later.decode("r")
    return store
