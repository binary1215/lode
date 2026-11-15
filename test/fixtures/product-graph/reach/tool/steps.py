"""Synthetic steps: first is one hop from the command, second is two."""


def first():
    return second()


def second():
    return 1


def unused():
    return 2
