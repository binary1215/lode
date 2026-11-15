"""Built-in calls in Python."""


def work(items, text):
    size = len(items)
    items.append(size)
    return str.lower(text)
